import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { specToGraph } from "../../../src/lib/utils/spec-graph-adapter";

const fixturePath = resolve(
	process.cwd(),
	"scripts/fixtures/generator-critic/gan-harness-cli-showcase.json",
);

function loadFixture(): any {
	return JSON.parse(readFileSync(fixturePath, "utf8"));
}

describe("GAN harness CLI showcase fixture", () => {
	it("exposes the three improvement trigger inputs (both schema blocks)", () => {
		const spec = loadFixture();
		for (const block of [
			spec.document["x-workflow-builder"].input.schema.document.properties,
			spec.input.schema.document.properties,
		]) {
			expect(block.designPass?.default).toBe("true");
			expect(block.criticVotes?.default).toBe("2");
			expect(block.maxRestarts?.default).toBe("2");
		}
	});

	it("runs the two-pass design loop before negotiate", () => {
		const spec = loadFixture();
		const names = spec.do.map((e: any) => Object.keys(e)[0]);
		expect(names.indexOf("design")).toBeGreaterThan(names.indexOf("approve_goal_spec"));
		expect(names.indexOf("design")).toBeLessThan(names.indexOf("negotiate"));

		const design = spec.do.find((e: any) => e.design)?.design;
		expect(design.if).toContain("designPass");
		const sub = design.do.map((e: any) => Object.keys(e)[0]);
		expect(sub).toEqual(["design_propose", "design_review", "design_read"]);
		const propose = design.do.find((e: any) => e.design_propose)?.design_propose;
		expect(propose.with.agentConfig.instructions).toContain("design-tokens.json");
		expect(propose.with.agentConfig.instructions).toContain("wireframe.txt");
	});

	it("votes with N independent critics and gates the 2nd on criticVotes>=2", () => {
		const spec = loadFixture();
		const refine = spec.do.find((e: any) => e.refine)?.refine;
		const names = refine.do.map((e: any) => Object.keys(e)[0]);
		expect(names).toEqual([
			"generate",
			"gate",
			"evaluate",
			"evaluate_2",
			"read_verdict",
			"maybe_restart",
		]);
		const ev = refine.do.find((e: any) => e.evaluate)?.evaluate;
		const ev2 = refine.do.find((e: any) => e.evaluate_2)?.evaluate_2;
		expect(ev.with.agentConfig.instructions).toContain("verdict-0.json");
		expect(ev2.if).toContain("criticVotes");
		expect(ev2.with.agentConfig.instructions).toContain("verdict-1.json");
		// read_verdict aggregates the vote files skeptically (any-fail) and surfaces restart
		const rv = refine.do.find((e: any) => e.read_verdict)?.read_verdict;
		expect(rv.with.command).toContain("verdict-*.json");
		expect(rv.with.command).toContain("recommend_restart");
	});

	it("gives the Evaluator restart authority bounded by maxRestarts", () => {
		const spec = loadFixture();
		const refine = spec.do.find((e: any) => e.refine)?.refine;
		const mr = refine.do.find((e: any) => e.maybe_restart)?.maybe_restart;
		expect(mr.if).toContain("maxRestarts");
		expect(mr.with.command).toContain("reset");
		expect(mr.with.command).toContain("--hard");
		expect(mr.with.command).toContain("WFB_MAXRESTARTS");
	});

	it("still builds a non-empty canvas graph", () => {
		const spec = loadFixture();
		const graph = specToGraph(spec);
		expect(graph).not.toBeNull();
		const taskNodes = (graph!.nodes ?? []).filter(
			(n: any) => n.type !== "start" && n.type !== "end",
		);
		expect(taskNodes.length).toBeGreaterThan(0);
	});
});
