import { defineConfig } from "vitest/config";

// Self-contained config so vitest does NOT walk up into the SvelteKit root
// vite.config.ts (which pulls in the Svelte plugin and breaks startup here).
export default defineConfig({
	root: __dirname,
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		globals: false,
	},
});
