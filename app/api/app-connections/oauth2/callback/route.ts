import { NextResponse } from "next/server";

/**
 * OAuth2 callback handler.
 *
 * Returns an HTML page that delivers the authorization code back to the
 * parent window using two channels:
 *
 * 1. window.opener.postMessage() - the primary approach (matches AP upstream)
 * 2. localStorage - fallback for when Cross-Origin-Opener-Policy (COOP)
 *    severs the window.opener reference (Google OAuth sets COOP: same-origin,
 *    which breaks postMessage between the popup and parent).
 *
 * The parent window listens for both 'message' and 'storage' events,
 * using whichever fires first. The localStorage key is cleaned up after use.
 */
export function GET(request: Request) {
	const { searchParams } = new URL(request.url);

	const code = searchParams.get("code");
	const state = searchParams.get("state");
	const error = searchParams.get("error");
	const errorDescription = searchParams.get("error_description") ?? "";

	let payload: Record<string, string | null>;
	if (error) {
		payload = { error, errorDescription, state };
	} else if (code) {
		payload = { code, state };
	} else {
		payload = {
			error: "missing_code",
			errorDescription: "No authorization code received",
			state,
		};
	}

	const safePayload = JSON.stringify(JSON.stringify(payload));
	const safeStorageKey = JSON.stringify("oauth2_callback_result");
	const safeScopedStorageKey = JSON.stringify(
		state && state.length > 0 ? `oauth2_callback_result:${state}` : "",
	);

	const html = `<!DOCTYPE html>
<html>
<head><title>Connecting...</title></head>
<body>
<p>Completing connection&hellip; You can close this window.</p>
<script>
  var payload = JSON.parse(${safePayload});
  var storageKey = ${safeStorageKey};
  var scopedStorageKey = ${safeScopedStorageKey};
  var origin = window.location.origin;
  // Primary: postMessage (works when COOP doesn't block window.opener)
  try {
    if (window.opener) {
      window.opener.postMessage(payload, origin);
    }
  } catch (e) {
    // COOP may block access to window.opener
  }
  // Extra fallback: BroadcastChannel (more reliable than storage events in some browsers)
  try {
    if (payload && payload.state && typeof BroadcastChannel !== "undefined") {
      var bc = new BroadcastChannel("oauth2_callback_result:" + payload.state);
      bc.postMessage(payload);
      bc.close();
    }
  } catch (e) {
    // ignore
  }
  // Fallback: localStorage (works even when COOP severs window.opener)
  // The parent listens for the 'storage' event on this key.
  try {
    // Write the scoped key first to avoid a race where the parent processes the
    // unscoped key and cleans up before the scoped key is written.
    if (scopedStorageKey) {
      localStorage.setItem(scopedStorageKey, JSON.stringify(payload));
    }
    localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch (e) {
    // localStorage may be unavailable in some contexts
  }
  // Auto-close after a brief delay to let both channels deliver.
  // Leave the window open on error so the user can read what happened.
  if (payload && payload.code) {
    setTimeout(function() { window.close(); }, 1000);
  }
</script>
</body>
</html>`;

	return new NextResponse(html, {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}
