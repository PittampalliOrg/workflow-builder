import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * GET /api/app-connections/oauth2/callback
 *
 * OAuth2 callback handler. Two modes:
 *
 * 1. Popup mode: Returns HTML that posts the auth code to the parent window
 *    via postMessage/BroadcastChannel/localStorage.
 *
 * 2. Same-tab mode: Stores the auth code in a secure httpOnly cookie and
 *    redirects to /connections?oauth2_resume=1 where the server load function
 *    completes the token exchange. This is the reliable SvelteKit approach.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const oauthError = url.searchParams.get('error');
	const errorDescription = url.searchParams.get('error_description') ?? '';

	let payload: Record<string, string | null>;
	if (oauthError) {
		payload = { error: oauthError, errorDescription, state };
	} else if (code) {
		payload = { code, state };
	} else {
		payload = {
			error: 'missing_code',
			errorDescription: 'No authorization code received',
			state
		};
	}

	// Always store in a server-side cookie for the same-tab fallback.
	// This cookie is read by the connections page's server load function.
	if (state) {
		cookies.set('oauth2_callback', JSON.stringify(payload), {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: url.protocol === 'https:',
			maxAge: 300 // 5 minutes
		});
	}

	const safePayload = JSON.stringify(JSON.stringify(payload));
	const safeScopedStorageKey = JSON.stringify(
		state && state.length > 0 ? `oauth2_callback_result:${state}` : ''
	);

	const html = `<!DOCTYPE html>
<html>
<head><title>Connecting...</title></head>
<body>
<p>Completing connection&hellip; You can close this window.</p>
<script>
  var payload = JSON.parse(${safePayload});
  var scopedStorageKey = ${safeScopedStorageKey};
  var origin = window.location.origin;
  var delivered = false;
  // Primary: postMessage (works when COOP doesn't block window.opener)
  try {
    if (window.opener) {
      window.opener.postMessage(payload, origin);
      delivered = true;
    }
  } catch (e) {
    // COOP may block access to window.opener
  }
  // Extra fallback: BroadcastChannel
  try {
    if (payload && payload.state && typeof BroadcastChannel !== "undefined") {
      var bc = new BroadcastChannel("oauth2_callback_result:" + payload.state);
      bc.postMessage(payload);
      bc.close();
      delivered = true;
    }
  } catch (e) {}
  // Fallback: localStorage
  try {
    if (scopedStorageKey) {
      localStorage.setItem(scopedStorageKey, JSON.stringify(payload));
    }
  } catch (e) {}
  // Same-tab fallback: redirect to connections page (cookie has the code)
  if (!delivered && payload && payload.state) {
    window.location.replace("/connections?oauth2_resume=1&state=" + encodeURIComponent(payload.state));
    // return to prevent auto-close
  } else if (payload && payload.code) {
    setTimeout(function() { window.close(); }, 1000);
  }
</script>
</body>
</html>`;

	return new Response(html, {
		status: 200,
		headers: { 'content-type': 'text/html; charset=utf-8' }
	});
};
