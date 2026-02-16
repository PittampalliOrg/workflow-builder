import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
		setupFiles: ["./tests/setup.ts"],
		include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
		exclude: ["node_modules/**", "services/**", "e2e/**"],
	},
	resolve: {
		alias: {
			"@": path.resolve(rootDir, "."),
		},
	},
});
