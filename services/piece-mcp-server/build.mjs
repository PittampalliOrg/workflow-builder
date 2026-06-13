/**
 * Build script for piece-mcp-server
 *
 * Bundle our code, mark all node_modules as external
 * (AP pieces have deep dep trees).
 */

import { copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function build() {
  try {
    await esbuild.build({
      entryPoints: [
        resolve(__dirname, "src/index.ts"),
        resolve(__dirname, "src/sync-metadata.ts"),
      ],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      outdir: resolve(__dirname, "dist"),
      sourcemap: true,
      minify: false,
      keepNames: true,
      packages: "external",
      external: ["node:*"],
      logLevel: "info",
    });

    // Bake the code-free available-only catalog snapshot next to the bundled
    // sync-metadata.js so the deploy-time seed reads it (resolve(__dirname,
    // "piece-catalog-snapshot.json")). Optional — bundle-only builds still work.
    const snapshotSrc = resolve(__dirname, "src/piece-catalog-snapshot.json");
    if (existsSync(snapshotSrc)) {
      copyFileSync(snapshotSrc, resolve(__dirname, "dist/piece-catalog-snapshot.json"));
      console.log("Copied piece-catalog-snapshot.json → dist/");
    } else {
      console.log("No src/piece-catalog-snapshot.json (bundle-only build)");
    }

    console.log("Build completed successfully!");
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

build();
