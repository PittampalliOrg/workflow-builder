/**
 * Minimal sandbox-execution-api stub for the lite-profile screenshot run.
 * The Dev hub's server load lists Tier-2 previews through SEA; without a
 * reachable SEA the page 500s ("SANDBOX_EXECUTION_API_URL not configured").
 * This stub answers the list read with an empty fleet — the Playwright spec
 * supplies the real preview fixtures by intercepting the remote-function
 * reads client-side.
 *
 *   node tests/e2e/support/sea-stub.mjs   # listens on 127.0.0.1:39911
 */
import { createServer } from "node:http";

const PORT = Number(process.env.SEA_STUB_PORT ?? 39911);

const server = createServer((req, res) => {
	res.setHeader("Content-Type", "application/json");
	if (req.method === "GET" && req.url?.startsWith("/internal/vcluster-previews")) {
		res.end(
			JSON.stringify({
				previews: [],
				counts: {
					awake: 0, slept: 0, total: 0, baking: 0, free: 0,
					claimed: 0, recycling: 0, max: 4, totalMax: 12, poolSize: 2,
				},
			}),
		);
		return;
	}
	res.end(JSON.stringify({}));
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`[sea-stub] listening on http://127.0.0.1:${PORT}`);
});
