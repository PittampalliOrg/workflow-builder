import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

export default defineConfig({
  server: { port: 3400 },
  plugins: [
    tsConfigPaths(),
    tanstackStart({
      vite: { installDevServerMiddleware: true },
    }),
  ],
});
