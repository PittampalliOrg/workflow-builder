import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	new URL("./seed-workflows.ts", import.meta.url),
	"utf8",
);
const bundle = readFileSync(
	new URL("./seed-workflows.bundle.js", import.meta.url),
	"utf8",
);

function builderSeed(text: string): string {
	const start = text.indexOf('slug: "kimi-k3-juicefs-builder-agent"');
	if (start < 0) throw new Error("Kimi K3 JuiceFS builder seed is missing");
	const remainder = text.slice(start);
	const end = remainder.match(/\n\s*\}\);/);
	if (end?.index === undefined) {
		throw new Error("Kimi K3 JuiceFS builder seed is incomplete");
	}
	return remainder.slice(0, end.index);
}

describe("Kimi K3 JuiceFS builder seed", () => {
	it("persists the model contract and dedicated runtime isolation", () => {
		const seed = builderSeed(source);
		for (const field of [
			'slug: "kimi-k3-juicefs-builder-agent"',
			'runtime: "dapr-agent-py-juicefs"',
			'modelSpec: "kimi/kimi-k3"',
			'reasoningEffort: "max"',
			"contextWindowTokens: 1_048_576",
			'runtimeIsolation: "dedicated"',
		]) {
			expect(seed).toContain(field);
		}
	});

	it("includes runtime isolation in the persisted version config and config hash", () => {
		expect(source).toContain(
			'...(opts.runtimeIsolation\n\t\t\t? { runtimeIsolation: opts.runtimeIsolation }',
		);
		expect(source).toContain(".update(JSON.stringify(config))");
	});

	it("ships the same dedicated contract in the generated database seed bundle", () => {
		const seed = builderSeed(bundle);
		expect(seed).toContain('runtime: "dapr-agent-py-juicefs"');
		expect(seed).toContain('modelSpec: "kimi/kimi-k3"');
		expect(seed).toContain("contextWindowTokens: 1048576");
		expect(seed).toContain('runtimeIsolation: "dedicated"');
	});

	it("does not reseed the retired GLM-named identity", () => {
		expect(source).not.toContain("glm-juicefs-builder-agent");
		expect(bundle).not.toContain("glm-juicefs-builder-agent");
	});
});
