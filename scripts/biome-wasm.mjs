#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
	DiagnosticPrinter,
	MemoryFileSystem,
	Workspace,
} from "@biomejs/wasm-nodejs";
import { parse as parseJsonc } from "jsonc-parser";

const require = createRequire(import.meta.url);

function run(cmd, args, opts = {}) {
	const res = spawnSync(cmd, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...opts,
	});
	if (res.error) throw res.error;
	if (res.status !== 0) {
		const err = new Error(
			`Command failed: ${cmd} ${args.join(" ")}\n${res.stderr || ""}`.trim(),
		);
		// @ts-expect-error - attach details for callers
		err.status = res.status;
		throw err;
	}
	return res.stdout.trim();
}

function parseArgs(argv) {
	const [command, ...rest] = argv;
	const flags = new Set(rest.filter((a) => a.startsWith("--")));
	const patterns = rest.filter((a) => !a.startsWith("--"));
	return { command, flags, patterns };
}

function listGitChangedFiles(cwd) {
	const changed = new Set();

	for (const args of [
		["diff", "--name-only", "--diff-filter=ACMR"],
		["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
	]) {
		const out = run("git", args, { cwd });
		for (const line of out.split("\n")) {
			const f = line.trim();
			if (f) changed.add(f);
		}
	}

	// Include untracked files (e.g. newly added source files)
	try {
		const out = run("git", ["ls-files", "--others", "--exclude-standard"], {
			cwd,
		});
		for (const line of out.split("\n")) {
			const f = line.trim();
			if (f) changed.add(f);
		}
	} catch {
		// ignore
	}

	return Array.from(changed);
}

function resolveExtendedConfigs(rootConfig) {
	const extendsField = rootConfig.extends;
	const entries =
		typeof extendsField === "string"
			? [extendsField]
			: Array.isArray(extendsField)
				? extendsField
				: [];

	const extendedConfigurations = [];
	for (const specifier of entries) {
		const resolvedPath = require.resolve(specifier);
		const configText = readFileSync(resolvedPath, "utf8");
		const config = parseJsonc(configText);
		if (config && typeof config === "object") {
			extendedConfigurations.push([specifier, config]);
		}
	}
	return extendedConfigurations;
}

function printDiagnostics({ diagnostics, path: filePath, source }) {
	const printer = new DiagnosticPrinter(filePath, source);
	for (const d of diagnostics) {
		printer.print_simple(d);
	}
	const out = printer.finish();
	// Biome's printer returns a fully formatted string.
	process.stdout.write(out);
}

async function main() {
	const { command, flags } = parseArgs(process.argv.slice(2));
	if (!command || (command !== "check" && command !== "fix")) {
		process.stderr.write(
			"Usage: node scripts/biome-wasm.mjs <check|fix> [--changed]\n",
		);
		process.exit(2);
	}

	const repoRoot = process.cwd();
	const rootConfigText = readFileSync(
		path.join(repoRoot, "biome.jsonc"),
		"utf8",
	);
	const rootConfig = parseJsonc(rootConfigText);
	const extendedConfigurations = resolveExtendedConfigs(rootConfig);

	const fs = new MemoryFileSystem();
	const workspace = Workspace.withFileSystem(fs);
	const { projectKey } = workspace.openProject({
		openUninitialized: true,
		path: repoRoot,
	});

	workspace.updateSettings({
		projectKey,
		configuration: rootConfig,
		extendedConfigurations,
		workspaceDirectory: repoRoot,
	});

	const files = flags.has("--changed") ? listGitChangedFiles(repoRoot) : [];

	let errors = 0;
	for (const rel of files) {
		// Skip directories and missing paths
		const abs = path.join(repoRoot, rel);
		let source;
		try {
			source = readFileSync(abs, "utf8");
		} catch {
			continue;
		}

		// Load file into the workspace from the "client".
		try {
			workspace.openFile({
				projectKey,
				path: abs,
				content: { type: "fromClient", content: source, version: 0 },
			});
		} catch {
			continue;
		}

		const featureResult = workspace.fileFeatures({
			projectKey,
			path: abs,
			features: ["format", "lint"],
		});

		const formatSupport = featureResult.featuresSupported.format;
		const lintSupport = featureResult.featuresSupported.lint;
		const supportsFormat = formatSupport === "supported";
		const supportsLint = lintSupport === "supported";

		if (!supportsFormat && !supportsLint) {
			workspace.closeFile({ projectKey, path: abs });
			continue;
		}

		if (command === "fix") {
			const result = workspace.fixFile({
				projectKey,
				path: abs,
				fixFileMode: "safeFixes",
				ruleCategories: ["syntax", "lint"],
				shouldFormat: true,
			});

			if (result.code !== source) {
				writeFileSync(abs, result.code, "utf8");
			}

			workspace.closeFile({ projectKey, path: abs });
			continue;
		}

		// check
		if (supportsLint) {
			const diag = workspace.pullDiagnostics({
				projectKey,
				path: abs,
				categories: ["syntax", "lint"],
				pullCodeActions: false,
			});

			if (diag.errors > 0) {
				errors += diag.errors;
				printDiagnostics({ diagnostics: diag.diagnostics, path: rel, source });
			}
		}

		if (supportsFormat) {
			const printed = workspace.formatFile({ projectKey, path: abs });
			const formatted =
				printed && typeof printed === "object" && "code" in printed
					? printed.code
					: null;
			if (typeof formatted === "string" && formatted !== source) {
				errors += 1;
				process.stdout.write(`${rel}: needs formatting (run pnpm fix)\n`);
			}
		}

		workspace.closeFile({ projectKey, path: abs });
	}

	process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
