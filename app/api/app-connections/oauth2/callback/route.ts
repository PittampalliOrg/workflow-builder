import { NextResponse } from "next/server";

/**
 * OAuth2 callback handler.
 *
 * Returns an HTML page that delivers the authorization code back to the
 * parent window using two channels:
 *
 * 1. window.opener.postMessage() — the primary approach (matches AP upstream)
 * 2. localStorage — fallback for when Cross-Origin-Opener-Policy (COOP)
 *    severs the window.opener reference (Google OAuth sets COOP: same-origin,
 *    which breaks postMessage between the popup and parent).
 *
 * The parent window listens for both 'message' and 'storage' events,
 * using whichever fires first. The localStorage key is cleaned up after use.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description") ?? "";

  const payload = error
    ? { error, errorDescription }
    : code
      ? { code }
      : { error: "missing_code", errorDescription: "No authorization code received" };

  const safePayload = JSON.stringify(JSON.stringify(payload));

  const html = `<!DOCTYPE html>
<html>
<head><title>Connecting...</title></head>
<body>
<p>Completing connection&hellip; You can close this window.</p>
<script>
  var payload = JSON.parse(${safePayload});
  // Primary: postMessage (works when COOP doesn't block window.opener)
  try {
    if (window.opener) {
      window.opener.postMessage(payload, '*');
    }
  } catch (e) {
    // COOP may block access to window.opener
  }
  // Fallback: localStorage (works even when COOP severs window.opener)
  // The parent listens for the 'storage' event on this key.
  try {
    localStorage.setItem('oauth2_callback_result', JSON.stringify(payload));
  } catch (e) {
    // localStorage may be unavailable in some contexts
  }
  // Auto-close after a brief delay to let both channels deliver
  setTimeout(function() { window.close(); }, 1000);
</script>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
