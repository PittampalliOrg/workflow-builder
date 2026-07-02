import { existsSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const entries = [
	"scripts/seed-dev-user.ts",
	"scripts/seed-workflows.ts",
	"scripts/seed-swebench-fixtures.ts",
	"scripts/queue-swebench-environment-validation.ts",
	"scripts/sync-swebench-environment-builds.ts",
	"scripts/start-swebench-benchmark-run.ts",
	"scripts/backfill-agent-application-state.ts",
	"scripts/cutover-mlflow-application-lineage.ts",
	"scripts/session-native-cutover-purge.ts",
	// Seeds platform_oauth_apps rows from OAUTH_APP_<SUFFIX>_CLIENT_ID/SECRET
	// env vars. Wired into Job-db-seed.yaml so OAuth providers (github,
	// gitea, microsoft-*, google, notion, linkedin) auto-sync after the
	// dev/github user seed runs.
	"scripts/sync-oauth-apps.ts",
];

const aliasPlugin = {
	name: "workflow-builder-alias",
	setup(build) {
		build.onResolve({ filter: /^\$app\/environment$/ }, () => ({
			path: resolve(root, "scripts/esbuild-stubs/app-environment.js"),
		}));
		build.onResolve({ filter: /^\$env\/dynamic\/private$/ }, () => ({
			path: resolve(root, "scripts/esbuild-stubs/env-dynamic-private.js"),
		}));
		build.onResolve({ filter: /^\$env\/dynamic\/public$/ }, () => ({
			path: resolve(root, "scripts/esbuild-stubs/env-dynamic-public.js"),
		}));
		build.onResolve({ filter: /^\$lib\// }, (args) => ({
			path: resolveAlias(args.path),
		}));
	},
};

const rawFilePlugin = {
	name: "workflow-builder-raw-file",
	setup(build) {
		build.onResolve({ filter: /\?raw$/ }, (args) => {
			const filePath = args.path.replace(/\?raw$/, "");
			const resolvedPath = filePath.startsWith(".")
				? resolve(dirname(args.importer), filePath)
				: resolve(root, filePath);
			return { path: resolvedPath, namespace: "raw-file" };
		});
		build.onLoad({ filter: /.*/, namespace: "raw-file" }, async (args) => ({
			contents: `export default ${JSON.stringify(await readFile(args.path, "utf8"))};`,
			loader: "js",
		}));
	},
};

function resolveAlias(path) {
	const base = resolve(root, "src/lib", path.slice("$lib/".length));
	for (const candidate of [base, `${base}.ts`, `${base}.js`, `${base}.svelte`]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	for (const candidate of [
		resolve(base, "index.ts"),
		resolve(base, "index.js"),
	]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return base;
}

await mkdir(resolve(root, "scripts"), { recursive: true });

for (const entry of entries) {
	const outfile = entry.replace(/\.ts$/, ".bundle.js");
	await mkdir(dirname(resolve(root, outfile)), { recursive: true });
	await build({
		entryPoints: [entry],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		sourcemap: false,
		plugins: [aliasPlugin, rawFilePlugin],
		logLevel: "info",
	});
}
