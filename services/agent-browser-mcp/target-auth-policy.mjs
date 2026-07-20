export const WORKFLOW_BUILDER_ACCESS_TOKEN_COOKIE = "wb_access_token";

/**
 * Parse the execution-only target credential without creating a global browser
 * header. Older BFFs sent the Workflow Builder JWT as Bearer auth, so normalize
 * that form to the same host-scoped cookie during a rolling deployment.
 */
export function parseTargetAuth(headers) {
	const raw = String(headers["x-wfb-target-auth"] || "").trim();
	const host = String(headers["x-wfb-target-auth-host"] || "")
		.trim()
		.toLowerCase();
	if (!raw || !host) return null;
	if (/^bearer\s+/i.test(raw)) {
		const token = raw.replace(/^bearer\s+/i, "").trim();
		return token
			? {
					host,
					cookieName: WORKFLOW_BUILDER_ACCESS_TOKEN_COOKIE,
					cookieValue: token,
				}
			: null;
	}
	const eq = raw.indexOf("=");
	if (eq <= 0) return null;
	return {
		host,
		cookieName: raw.slice(0, eq),
		cookieValue: raw.slice(eq + 1),
	};
}
