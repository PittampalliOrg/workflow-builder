import { NextResponse } from "next/server";

// OAuth2 callback receiver.
//
// This is intentionally a tiny HTML response (Activepieces-style) instead of a
// React page to avoid any hydration/bundle-load timing issues inside the popup.
//
// It delivers the OAuth result to the opener via postMessage when possible,
// and always writes a localStorage fallback for when COOP severs window.opener.
export async function GET(request: Request) {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const error = url.searchParams.get("error");
	const errorDescription = url.searchParams.get("error_description");

	// Precompute a payload so it can be embedded safely.
	// We require `state` for all resumable flows to avoid collisions/stale results.
	const payload =
		error && state
			? { error, errorDescription, state }
			: code && state
				? { code, state }
				: !state
					? {
							error: "missing_state",
							errorDescription:
								"Missing OAuth state. Please restart the authorization flow.",
							state,
						}
					: {
							error: "missing_code",
							errorDescription: "No authorization code received",
							state,
						};

	// JSON.stringify output is safe to embed into a <script> as long as we escape
	// the closing script tag sequence. Avoid replaceAll for runtime compatibility.
	const payloadJson = JSON.stringify(payload)
		.split("</script>")
		.join("<\\/script>");

	const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Completing connection...</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 0; }
      .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #334155; }
      .card { max-width: 520px; width: 100%; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px 16px; background: #fff; }
      .title { font-size: 14px; font-weight: 600; margin: 0 0 6px; color: #0f172a; }
      .desc { font-size: 13px; margin: 0; color: #475569; line-height: 1.45; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <p class="title">Completing connection</p>
        <p class="desc">You can close this window if it doesn't close automatically.</p>
      </div>
    </div>
	    <script>
	      (function () {
	        var payload = ${payloadJson};

	        // Primary: postMessage (works when COOP doesn't block window.opener)
	        try {
	          if (window.opener) {
	            window.opener.postMessage(payload, window.location.origin);
	          }
	        } catch (_) {}

	        // Extra fallback: BroadcastChannel (more reliable than storage events in some browsers)
	        try {
	          if (payload && payload.state && typeof BroadcastChannel !== "undefined") {
	            var bc = new BroadcastChannel("oauth2_callback_result:" + payload.state);
	            bc.postMessage(payload);
	            bc.close();
	          }
	        } catch (_) {}

	        // Fallback: localStorage (works even when COOP severs window.opener)
	        // Prefer the state-scoped key to avoid collisions and stale entries.
	        try {
	          if (payload && payload.state) {
	            localStorage.setItem("oauth2_callback_result:" + payload.state, JSON.stringify(payload));
	          }
	        } catch (_) {}

	        // Same-tab fallback: when the popup is blocked, we navigate the main tab to
	        // the provider. In that case, window.opener is null and we need to return
	        // to /connections to finish the flow.
	        var sameTabState = null;
	        try { sameTabState = sessionStorage.getItem("oauth2_same_tab_state"); } catch (_) {}
	        var shouldReturnToConnections = !window.opener && payload && payload.state && sameTabState === payload.state;
	        if (shouldReturnToConnections) {
	          try { sessionStorage.removeItem("oauth2_same_tab_state"); } catch (_) {}
	          try { window.location.replace("/connections?oauth2_resume=1&state=" + encodeURIComponent(payload.state)); } catch (_) {}
	          return;
	        }

	        if (payload && payload.code) {
	          setTimeout(function () { window.close(); }, 750);
	        }
	      })();
	    </script>
	  </body>
	</html>`;

	return new NextResponse(html, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store, max-age=0",
		},
	});
}
