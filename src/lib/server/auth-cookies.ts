// Cookie names must match the legacy Next.js auth surface.
export const ACCESS_TOKEN_COOKIE = "wb_access_token";
export const REFRESH_TOKEN_COOKIE = "wb_refresh_token";

export function shouldUseSecureCookies(request: Request): boolean {
	const forwardedProto = request.headers
		.get("x-forwarded-proto")
		?.split(",")[0]
		?.trim();
	const protocol = forwardedProto || new URL(request.url).protocol.replace(":", "");
	return protocol === "https";
}
