import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("./", import.meta.url);

function source(name) {
	return readFileSync(new URL(name, root), "utf8");
}

function copiedFiles() {
	const files = new Set();
	for (const line of source("Dockerfile").split("\n")) {
		if (!line.startsWith("COPY ")) continue;
		const parts = line.trim().split(/\s+/).slice(1);
		for (const item of parts.slice(0, -1)) files.add(basename(item));
	}
	return files;
}

function imports(name) {
	const text = source(name);
	return [
		...text.matchAll(/\bfrom\s+["']([^"']+)["']/g),
		...text.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
	].map((match) => match[1]);
}

function packageName(specifier) {
	if (specifier.startsWith("@"))
		return specifier.split("/").slice(0, 2).join("/");
	return specifier.split("/")[0];
}

describe("agent-browser production image contract", () => {
	it("installs and runs local Chrome as the unprivileged runtime user", () => {
		const dockerfile = source("Dockerfile");
		const runtimeUser = dockerfile.indexOf("USER node");
		const browserInstall = dockerfile.indexOf("RUN agent-browser install");
		const command = dockerfile.indexOf('CMD ["node", "bridge.mjs"]');

		assert.match(
			dockerfile,
			/ENV HOME=\/home\/node \\\n\tAGENT_BROWSER_ARGS=--no-sandbox/,
		);
		assert.ok(runtimeUser >= 0, "Dockerfile must select the non-root node user");
		assert.ok(
			runtimeUser < browserInstall,
			"Chrome must be installed by the runtime user",
		);
		assert.ok(
			browserInstall < command,
			"Chrome installation must precede the bridge command",
		);
		assert.equal(
			dockerfile.slice(runtimeUser).match(/^USER /gm)?.length,
			1,
			"the image must not switch back to root",
		);
	});

	it("copies every local bridge startup module", () => {
		const copied = copiedFiles();
		const pending = ["bridge.mjs"];
		const visited = new Set();
		while (pending.length) {
			const current = pending.pop();
			if (visited.has(current)) continue;
			visited.add(current);
			assert.ok(copied.has(current), `${current} is not copied by Dockerfile`);
			for (const specifier of imports(current)) {
				if (!specifier.startsWith("./")) continue;
				const dependency = basename(specifier);
				assert.ok(
					copied.has(dependency),
					`${current} imports ${dependency}, but Dockerfile omits it`,
				);
				pending.push(dependency);
			}
		}
		assert.ok(visited.has("target-auth-policy.mjs"));
	});

	it("declares bare startup imports and parses every copied module", () => {
		const manifest = JSON.parse(source("package.json"));
		for (const specifier of imports("bridge.mjs")) {
			if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
			assert.ok(
				manifest.dependencies?.[packageName(specifier)],
				`package.json omits runtime dependency ${packageName(specifier)}`,
			);
		}
		for (const file of copiedFiles()) {
			if (!file.endsWith(".mjs")) continue;
			const checked = spawnSync(
				process.execPath,
				["--check", fileURLToPath(new URL(file, root))],
				{ encoding: "utf8" },
			);
			assert.equal(checked.status, 0, checked.stderr || checked.stdout);
		}
	});
});
