import { NextResponse } from "next/server";

// Lightweight same-origin popup shell.
//
// We open the popup to this URL synchronously (user gesture) to avoid popup
// blockers that aggressively close about:blank popups. The client then
// navigates this window to the provider's authorization URL.
export function GET() {
	const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Starting authorization...</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 0; }
      .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #334155; background: #fff; }
      .card { max-width: 520px; width: 100%; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px 16px; }
      .title { font-size: 14px; font-weight: 600; margin: 0 0 6px; color: #0f172a; }
      .desc { font-size: 13px; margin: 0; color: #475569; line-height: 1.45; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <p class="title">Starting authorization</p>
        <p class="desc">This window should redirect to the provider shortly.</p>
      </div>
    </div>
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
