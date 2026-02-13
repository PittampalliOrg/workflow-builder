/**
 * Build script for workflow-mcp-server
 *
 * Bundle server code, mark all node_modules as external.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function build() {
  try {
    await esbuild.build({
      entryPoints: [resolve(__dirname, "src/index.ts")],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      outfile: resolve(__dirname, "dist/index.js"),
      sourcemap: true,
      minify: false,
      keepNames: true,
      packages: "external",
      external: ["node:*"],
      logLevel: "info",
    });

    console.log("Build completed successfully!");
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

build();
