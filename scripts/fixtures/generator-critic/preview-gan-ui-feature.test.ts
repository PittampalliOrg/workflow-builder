import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { specToGraph } from "../../../src/lib/utils/spec-graph-adapter";

const fixturePath = resolve(
	process.cwd(),
	"scripts/fixtures/generator-critic/preview-gan-ui-feature.json",
);
const spec = () => JSON.parse(readFileSync(fixturePath, "utf8"));

describe("preview-gan-ui-feature fixture", () => {
	it("builds a valid canvas graph", () => {
		const g = specToGraph(spec());
		expect(g.nodes.length).toBeGreaterThan(5);
	});

	it("has the GAN UI-feature node sequence with a gated promote", () => {
		const ids = spec().do.map((n: any) => Object.keys(n)[0]);
		expect(ids).toEqual([
			"enter_dev_mode",
			"plan",
			"design_review",
			"refine",
			"promote",
			"summary",
		]);
		const refine = spec().do.find((n: any) => n.refine).refine;
		expect(refine.do.map((n: any) => Object.keys(n)[0])).toEqual([
			"generate",
			"snapshot",
			"critique",
		]);
	});

	it("adopts the workflow-builder preview (adopt:true)", () => {
		const enter = spec().do.find((n: any) => n.enter_dev_mode).enter_dev_mode;
		expect(enter.with.adopt).toBe(true);
		expect(enter.with.timeoutSeconds).toBe(86400);
	});

	it("exposes the generic UI-feature inputs in both schema blocks", () => {
		const s = spec();
		for (const block of [
			s.document["x-workflow-builder"].input.schema.document.properties,
			s.input.schema.document.properties,
		]) {
			expect(block.generatorAgent?.default).toBe("gan-generator-ultracode");
			expect(block.criticAgent?.default).toBe("gan-critic-claude");
			expect(block.previewLogin?.default).toBe("admin@example.com");
			expect(block.previewPassword?.default).toBe("developer");
			expect(block.maxIterations?.default).toBe(5);
			expect(block.outputMode?.default).toBe("pr");
			expect(block.evaluationRoutes?.default).toEqual(["/dashboard"]);
			// generic: no baked route-redesign field
			expect(block.targetRoute).toBeUndefined();
		}
	});

	it("pins Opus 4.8 + ultracode effort on the planner and generator (belt-and-braces)", () => {
		const s = spec();
		const plan = s.do.find((n: any) => n.plan).plan;
		const refine = s.do.find((n: any) => n.refine).refine;
		const generate = refine.do.find((n: any) => n.generate).generate;
		for (const node of [plan, generate]) {
			expect(node.with.agentConfig.modelSpec).toBe("claude-opus-4-8");
			expect(node.with.agentConfig.effort).toBe("ultracode");
			// both phases run the ultracode generator agent by default
			expect(node.with.agentRef.slug).toContain("gan-generator-ultracode");
		}
	});

	it("grades a machine-readable verdict and gates the PR on outputMode", () => {
		const s = spec();
		const refine = s.do.find((n: any) => n.refine).refine;
		const critique = refine.do.find((n: any) => n.critique).critique;
		expect(critique.parseJson).toBe(true);
		expect(critique.with.agentConfig.instructions).toContain("strict JSON");
		const promote = s.do.find((n: any) => n.promote).promote;
		expect(promote.if).toContain("outputMode");
		expect(promote.with.command).toContain(
			"PittampalliOrg/workflow-builder",
		);
	});
});
