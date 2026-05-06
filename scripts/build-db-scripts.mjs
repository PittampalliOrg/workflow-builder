import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const entries = [
	"scripts/seed-dev-user.ts",
	"scripts/seed-workflows.ts",
	"scripts/seed-swebench-fixtures.ts",
	"scripts/queue-swebench-environment-validation.ts",
	"scripts/start-swebench-benchmark-run.ts",
];

const aliasPlugin = {
	name: "workflow-builder-alias",
	setup(build) {
		build.onResolve({ filter: /^\$lib\// }, (args) => ({
			path: resolveAlias(args.path),
		}));
	},
};

function resolveAlias(path) {
	const base = resolve(root, "src/lib", path.slice("$lib/".length));
	for (const candidate of [base, `${base}.ts`, `${base}.js`, `${base}.svelte`]) {
		if (existsSync(candidate)) return candidate;
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
		plugins: [aliasPlugin],
		logLevel: "info",
	});
}
