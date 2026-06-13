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

// BUILD_VARIANT=single → per-piece / base image: stub the static 48-piece registry so
// esbuild never emits the eager require("@activepieces/piece-*") calls. getPiece then
// loads the one installed piece dynamically (SINGLE_PIECE_MODE at runtime). The default
// (bundle) build is unchanged. See docs/per-piece-runtime-images.md.
const SINGLE_VARIANT = process.env.BUILD_VARIANT === "single";
const stubStaticRegistryPlugin = {
  name: "stub-static-piece-registry",
  setup(build) {
    // The static 48-piece map.
    build.onResolve({ filter: /piece-registry\.static(\.js)?$/ }, () => ({
      path: resolve(__dirname, "src/piece-registry.empty.ts"),
    }));
    // Bespoke extensions statically import specific bundled pieces (onedrive) — drop
    // them in single-piece images (a per-piece image only carries its own piece).
    build.onResolve({ filter: /extensions\/index(\.js)?$/ }, () => ({
      path: resolve(__dirname, "src/extensions/empty.ts"),
    }));
  },
};

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
      plugins: SINGLE_VARIANT ? [stubStaticRegistryPlugin] : [],
      logLevel: "info",
    });
    if (SINGLE_VARIANT) console.log("BUILD_VARIANT=single — static piece registry stubbed (no bundled pieces)");

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
