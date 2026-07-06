import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
		// Env applied before test modules load, so module-scope consts (e.g.
		// INTERNAL_API_TOKEN) capture these values. Poll fast so wait-mode tests
		// don't sleep.
		env: {
			INTERNAL_API_TOKEN: "test-token",
			SCRIPT_WAIT_POLL_INTERVAL_MS: "1",
			SCRIPT_WAIT_TIMEOUT_MS: "5000",
		},
	},
});
