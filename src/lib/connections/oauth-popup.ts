/**
 * OAuth connect flow for Activepieces app connections.
 *
 * Extracted from /workspaces/[slug]/connections/+page.svelte so the
 * Integrations hub, the piece detail subroute, and (later) the canvas
 * step side-panel can share ONE implementation. This module is
 * framework-free: no Svelte imports, no component coupling — only
 * `fetch`, `localStorage`, and `window.location`.
 *
 * ## How the flow works (characterized from the original page)
 *
 * This is a SAME-TAB redirect flow with a localStorage pending-state
 * machine (the "popup" naming is historical — the OAuth callback
 * endpoint's same-tab cookie redirect is the only mode in production):
 *
 * 1. `startOAuthConnect()` creates the app-connection row
 *    (`POST /api/app-connections`, type `PLATFORM_OAUTH2`), asks the BFF
 *    for an authorization URL (`POST /api/app-connections/oauth2/start`,
 *    PKCE: returns `state` + `codeVerifier`), persists a
 *    {@link PendingOAuthConnection} under {@link OAUTH_PENDING_KEY} in
 *    localStorage, then navigates the tab to the provider's
 *    authorization URL.
 * 2. The provider redirects back to
 *    `/api/app-connections/oauth2/callback`, which stores the
 *    `{code, state}` payload in a short-lived httpOnly cookie and 302s to
 *    `/connections?oauth2_resume=1` (which itself redirects to the
 *    workspace-scoped connections page). The page's server `load` reads +
 *    deletes the cookie and exposes it as `data.oauthCallback`.
 * 3. On mount the page calls {@link inspectOAuthCallback} with that
 *    payload. When it reports `ready` (pending state matches the callback
 *    `state` and a `code` is present), {@link completePendingOAuth}
 *    exchanges the code (`POST /api/app-connections/oauth2/complete`) and
 *    clears the pending key. The pending key is INTENTIONALLY kept when
 *    completion fails so a reload can retry.
 *
 * The caller owns all UX side effects (toasts, busy state, MCP
 * enablement via `pending.addMcp`, navigation after completion).
 */

/** localStorage key for the pending OAuth state machine (do not change — in-flight connects depend on it). */
export const OAUTH_PENDING_KEY = 'workflow-builder:pending-oauth2-connection';

/** Pending state persisted in localStorage between redirect-out and redirect-back. */
export type PendingOAuthConnection = {
	/** PKCE `state` returned by /oauth2/start; must match the callback's `state`. */
	state: string;
	/** The pre-created app-connection row id, finalized by /oauth2/complete. */
	connectionId: string;
	/** Canonical piece name (`@activepieces/piece-…`). */
	pieceName: string;
	/** PKCE code verifier returned by /oauth2/start. */
	codeVerifier: string;
	/** Redirect URL registered with the provider (echoed by /oauth2/start). */
	redirectUrl: string;
	/** Caller hint: enable the piece MCP server after completion. */
	addMcp: boolean;
};

/** Server-load callback payload (from the oauth2_callback cookie). */
export type OAuthCallbackPayload = Record<string, string | null>;

/** Minimal app-connection shape returned by the connection endpoints. */
export type OAuthAppConnectionSummary = {
	id: string;
	externalId: string;
	pieceName: string;
	displayName: string;
	type: string;
	status: string;
	[key: string]: unknown;
};

export type StartOAuthConnectOptions = {
	/** Canonical piece name (`@activepieces/piece-…`). */
	pieceName: string;
	/** Display name for the new connection row. */
	displayName: string;
	/** Persisted into pending state; the resuming caller decides what to do with it. */
	addMcp?: boolean;
	/**
	 * Pass the catalog entry's `oauthAppConfigured` flag. When explicitly
	 * `false` the start is rejected up-front (same guard + message the
	 * connections page always used) without creating any rows.
	 */
	oauthAppConfigured?: boolean;
	/** Override the OAuth callback URL (default: `${origin}/api/app-connections/oauth2/callback`). */
	redirectUrl?: string;
	/** Override navigation (default: `window.location.href = authorizationUrl`). Useful for tests/popups. */
	navigate?: (authorizationUrl: string) => void;
	/** Override fetch (default: global `fetch`). */
	fetchImpl?: typeof fetch;
};

export type StartedOAuthConnect = {
	connectionId: string;
	connectionExternalId: string;
	state: string;
	authorizationUrl: string;
	pending: PendingOAuthConnection;
};

export type OAuthConnectHandle = {
	/**
	 * Resolves once the pending state is persisted and navigation to the
	 * provider has been initiated (the page is expected to unload right
	 * after). Rejects on guard/HTTP failures or after `cancel()`.
	 */
	promise: Promise<StartedOAuthConnect>;
	/**
	 * Abort in-flight start requests and clear any pending state this
	 * handle persisted. No-op once navigation has been initiated.
	 */
	cancel: () => void;
};

/** Result of inspecting the server-load callback payload against pending state. */
export type OAuthCallbackInspection =
	| { kind: 'none' }
	| { kind: 'error'; message: string }
	| { kind: 'ready'; pending: PendingOAuthConnection; code: string };

export class OAuthConnectCancelledError extends Error {
	constructor() {
		super('OAuth connect was cancelled');
		this.name = 'OAuthConnectCancelledError';
	}
}

/** Read the pending OAuth state (null when absent or unparsable). */
export function readPendingOAuth(): PendingOAuthConnection | null {
	const raw = localStorage.getItem(OAUTH_PENDING_KEY);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as PendingOAuthConnection;
	} catch {
		return null;
	}
}

/** Clear the pending OAuth state. */
export function clearPendingOAuth(): void {
	localStorage.removeItem(OAUTH_PENDING_KEY);
}

/**
 * Begin an OAuth connect: create the connection row, fetch the
 * authorization URL, persist pending state, and redirect this tab to the
 * provider. See module docs for the full state machine.
 */
export function startOAuthConnect(options: StartOAuthConnectOptions): OAuthConnectHandle {
	const controller = new AbortController();
	let cancelled = false;
	let persisted = false;
	let navigated = false;
	const fetchImpl = options.fetchImpl ?? fetch;

	const promise = (async (): Promise<StartedOAuthConnect> => {
		if (options.oauthAppConfigured === false) {
			throw new Error('Configure the platform OAuth app before connecting this provider');
		}

		const redirectUrl =
			options.redirectUrl ?? `${window.location.origin}/api/app-connections/oauth2/callback`;

		const createRes = await fetchImpl('/api/app-connections', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				pieceName: options.pieceName,
				displayName: options.displayName,
				type: 'PLATFORM_OAUTH2',
				value: {
					redirect_url: redirectUrl
				}
			}),
			signal: controller.signal
		});
		if (!createRes.ok) throw new Error(await createRes.text());
		const connection = (await createRes.json()) as OAuthAppConnectionSummary;

		const startRes = await fetchImpl('/api/app-connections/oauth2/start', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				pieceName: options.pieceName,
				redirectUrl
			}),
			signal: controller.signal
		});
		if (!startRes.ok) throw new Error(await startRes.text());
		const start = (await startRes.json()) as {
			authorizationUrl: string;
			state: string;
			codeVerifier: string;
			redirectUrl: string;
		};

		const pending: PendingOAuthConnection = {
			state: start.state,
			connectionId: connection.id,
			pieceName: options.pieceName,
			codeVerifier: start.codeVerifier,
			redirectUrl: start.redirectUrl,
			addMcp: Boolean(options.addMcp)
		};

		if (cancelled) throw new OAuthConnectCancelledError();
		localStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify(pending));
		persisted = true;

		if (cancelled) throw new OAuthConnectCancelledError();
		navigated = true;
		const navigate =
			options.navigate ??
			((authorizationUrl: string) => {
				window.location.href = authorizationUrl;
			});
		navigate(start.authorizationUrl);

		return {
			connectionId: connection.id,
			connectionExternalId: connection.externalId,
			state: start.state,
			authorizationUrl: start.authorizationUrl,
			pending
		};
	})();

	return {
		promise,
		cancel: () => {
			if (navigated) return;
			cancelled = true;
			controller.abort();
			if (persisted) clearPendingOAuth();
		}
	};
}

/**
 * Inspect a server-load OAuth callback payload against the pending state.
 *
 * - `none`: no callback, no pending state, state mismatch, or missing
 *   code — nothing to do (pending state is left untouched).
 * - `error`: the provider returned an OAuth error (pending state is left
 *   untouched, matching the original page behavior).
 * - `ready`: call {@link completePendingOAuth} next.
 */
export function inspectOAuthCallback(
	callback: OAuthCallbackPayload | null | undefined
): OAuthCallbackInspection {
	if (!callback) return { kind: 'none' };
	if (callback.error) {
		return { kind: 'error', message: callback.errorDescription || callback.error };
	}
	const pending = readPendingOAuth();
	if (!pending) return { kind: 'none' };
	if (pending.state !== callback.state || !callback.code) return { kind: 'none' };
	return { kind: 'ready', pending, code: callback.code };
}

/**
 * Exchange the authorization code for tokens and finalize the
 * connection. Clears the pending key on success ONLY (a failed exchange
 * keeps it so a reload can retry — original behavior). Throws on HTTP
 * failure with the server's error text.
 */
export async function completePendingOAuth(
	input: { pending: PendingOAuthConnection; code: string },
	fetchImpl: typeof fetch = fetch
): Promise<OAuthAppConnectionSummary> {
	const { pending, code } = input;
	const completeRes = await fetchImpl('/api/app-connections/oauth2/complete', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			connectionId: pending.connectionId,
			pieceName: pending.pieceName,
			code,
			codeVerifier: pending.codeVerifier,
			redirectUrl: pending.redirectUrl
		})
	});
	if (!completeRes.ok) throw new Error(await completeRes.text());
	const body = (await completeRes.json()) as { connection: OAuthAppConnectionSummary };
	clearPendingOAuth();
	return body.connection;
}
