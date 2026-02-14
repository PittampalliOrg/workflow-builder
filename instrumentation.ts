export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs") {
		return;
	}
	const { initNodeOtel } = await import("./lib/otel/init-node");
	initNodeOtel("workflow-builder");
}
