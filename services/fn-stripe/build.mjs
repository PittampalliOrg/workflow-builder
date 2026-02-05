/**
 * Build script for fn-stripe OpenFunction
 */
import * as esbuild from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
      minify: false,
      keepNames: true,
      external: ["node:*"],
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
