// app.config.ts
import { defineConfig } from "@tanstack/react-start/config";
import tsConfigPaths from "vite-tsconfig-paths";
var app_config_default = defineConfig({
  vite: {
    plugins: () => [tsConfigPaths()]
  },
  server: {
    port: 3400
  }
});
export {
  app_config_default as default
};
