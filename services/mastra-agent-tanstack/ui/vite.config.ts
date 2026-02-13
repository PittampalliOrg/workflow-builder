import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
	root: __dirname,
	plugins: [react(), viteSingleFile()],
	build: {
		rollupOptions: {
			input: "agent-monitor/index.html",
		},
		outDir: "../dist-ui",
		emptyOutDir: true,
	},
});
