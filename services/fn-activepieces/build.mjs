/**
 * Build script for fn-activepieces
 *
 * NOTE: AP pieces have many SDK deps (googleapis, @notionhq/client, etc.)
 * that cannot be bundled by esbuild. We bundle only our code and mark
 * all node_modules as external — the Docker image ships node_modules.
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
      format: "cjs",
      outfile: resolve(__dirname, "dist/index.js"),
      sourcemap: true,
      minify: false,
      keepNames: true,
      // Mark ALL packages as external — AP pieces have deep dep trees
      // that esbuild cannot reliably bundle (native modules, etc.)
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
