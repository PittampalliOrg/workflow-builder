import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitroV2Plugin } from "@tanstack/nitro-v2-vite-plugin";

export default defineConfig({
  server: { port: 3400 },
  plugins: [
    tsConfigPaths(),
    tanstackStart({
      vite: { installDevServerMiddleware: true },
    }),
    nitroV2Plugin({
      preset: "node-server",
      externals: {
        // Force-inline zod — Nitro picks up nested zod@4 (from @mastra/schema-compat)
        // instead of the top-level zod@3, causing ERR_MODULE_NOT_FOUND at runtime
        inline: ["zod"],
      },
    }),
  ],
});
