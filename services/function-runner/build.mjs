/**
 * Build script for Function Runner Service
 *
 * Uses esbuild to bundle the service with all dependencies,
 * resolving path aliases (@/*) and the server-only shim.
 */
import * as esbuild from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../..");

/**
 * Try to resolve a path with multiple extensions
 */
function resolveWithExtensions(basePath) {
  const extensions = [".ts", ".tsx", ".js", ".jsx", ""];
  for (const ext of extensions) {
    const fullPath = basePath + ext;
    if (existsSync(fullPath)) {
      return fullPath;
    }
    // Also try index files
    const indexPath = resolve(basePath, "index" + ext);
    if (existsSync(indexPath)) {
      return indexPath;
    }
  }
  return null;
}

/** @type {import('esbuild').Plugin} */
const aliasPlugin = {
  name: "alias",
  setup(build) {
    // Resolve @/* to the root directory
    build.onResolve({ filter: /^@\// }, (args) => {
      const path = args.path.replace(/^@\//, "");
      // Remove .js extension if present (TypeScript adds it)
      const cleanPath = path.replace(/\.js$/, "");
      const basePath = resolve(rootDir, cleanPath);

      const resolved = resolveWithExtensions(basePath);
      if (resolved) {
        return { path: resolved };
      }

      // Fallback to original path
      return { path: basePath };
    });

    // Resolve server-only to our shim
    build.onResolve({ filter: /^server-only$/ }, () => {
      return {
        path: resolve(__dirname, "src/shims/server-only.ts"),
      };
    });
  },
};

async function build() {
  try {
    await esbuild.build({
      entryPoints: [resolve(__dirname, "src/index.ts")],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      outfile: resolve(__dirname, "dist/index.js"),
      sourcemap: true,
      minify: false, // Keep readable for debugging
      keepNames: true,
      plugins: [aliasPlugin],
      // Mark node built-ins as external
      external: [
        // Node built-ins
        "node:*",
        // Native dependencies that can't be bundled
        "pg-native",
      ],
      // Banner to handle __dirname in ESM
      banner: {
        js: `
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
`.trim(),
      },
      logLevel: "info",
    });

    console.log("Build completed successfully!");
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

build();
