export function allowAnonymousDaprDebug(): boolean {
	return process.env.NODE_ENV !== "production";
}
