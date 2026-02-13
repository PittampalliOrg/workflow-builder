import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  root: __dirname,
  plugins: [react(), viteSingleFile()],
  build: {
    rollupOptions: {
      input: process.env.INPUT || "microsoft-todo/index.html",
    },
    outDir: "../dist/ui",
    emptyOutDir: false,
  },
});
