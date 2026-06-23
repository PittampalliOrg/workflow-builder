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

	it("exposes the general-harness trigger inputs defaulting to ui-web behavior", () => {
		const spec = loadFixture();
		for (const block of [
			spec.document["x-workflow-builder"].input.schema.document.properties,
			spec.input.schema.document.properties,
		]) {
			expect(block.repoUrl?.default).toBe("PittampalliOrg/sveltekit-landing-demo");
			expect(block.repoRef?.default).toBe("main");
			expect(block.evaluationProfile?.default).toBe("ui-web");
			expect(block.outputMode?.default).toBe("pr");
			expect(block.testCommand?.default).toBe("auto");
			expect(block.taskScope?.default).toBeTruthy();
		}
	});

	it("parameterizes the repo (no hardcoded URL in plan/pr) + reads repoRef", () => {
		const spec = loadFixture();
		const plan = spec.do.find((e: any) => e.plan)?.plan;
		expect(plan.with.body.prompt).toContain(".trigger.repoUrl");
		expect(plan.with.body.prompt).toContain(".trigger.repoRef");
		// plan instructions must NOT hardcode the demo repo anymore
		expect(plan.with.agentConfig.instructions).not.toContain("sveltekit-landing-demo");
		// pr is a plain shell reading the dotfiles init_state wrote; gated by outputMode
		const pr = spec.do.find((e: any) => e.pr)?.pr;
		expect(pr.if).toContain("outputMode");
		expect(pr.with.command).toContain("/sandbox/work/.wfb_repo");
		expect(pr.with.command).toContain("BRANCH_PUSHED");
		const init = spec.do.find((e: any) => e.init_state)?.init_state;
		expect(init.with.command).toContain("/sandbox/work/.wfb_repo");
		expect(init.with.command).toContain("/sandbox/work/.wfb_profile");
	});

	it("two-pass design loop runs before negotiate and is gated to ui-web", () => {
		const spec = loadFixture();
		const names = spec.do.map((e: any) => Object.keys(e)[0]);
		expect(names.indexOf("design")).toBeGreaterThan(names.indexOf("approve_goal_spec"));
		expect(names.indexOf("design")).toBeLessThan(names.indexOf("negotiate"));

		const design = spec.do.find((e: any) => e.design)?.design;
		expect(design.if).toContain("designPass");
		expect(design.if).toContain("evaluationProfile"); // design only for ui-web
		const sub = design.do.map((e: any) => Object.keys(e)[0]);
		expect(sub).toEqual(["design_propose", "design_review", "design_read"]);
	});

	it("profile-gated evaluators: ui (Playwright) vs code (run tests), both vote-aware", () => {
		const spec = loadFixture();
		const refine = spec.do.find((e: any) => e.refine)?.refine;
		const names = refine.do.map((e: any) => Object.keys(e)[0]);
		expect(names).toEqual([
			"generate",
			"gate",
			"evaluate_ui",
			"evaluate_code",
			"evaluate_ui_2",
			"evaluate_code_2",
			"read_verdict",
			"maybe_restart",
		]);
		const get = (n: string) => refine.do.find((e: any) => e[n])?.[n];
		// ui evaluator → ui-web only, Playwright, verdict-0
		expect(get("evaluate_ui").if).toContain('== "ui-web"');
		expect(get("evaluate_ui").with.agentConfig.instructions).toContain("Playwright");
		expect(get("evaluate_ui").with.agentConfig.instructions).toContain("verdict-0.json");
		// code evaluator → non-ui-web, runs tests, NO browser, verdict-0
		expect(get("evaluate_code").if).toContain('!= "ui-web"');
		expect(get("evaluate_code").with.agentConfig.instructions).toContain("do NOT open a browser");
		expect(get("evaluate_code").with.agentConfig.instructions).toContain("verdict-0.json");
		// 2nd votes gated on criticVotes>=2 + their profile, write verdict-1
		expect(get("evaluate_ui_2").if).toContain("criticVotes");
		expect(get("evaluate_code_2").if).toContain("criticVotes");
		expect(get("evaluate_ui_2").with.agentConfig.instructions).toContain("verdict-1.json");
		expect(get("evaluate_code_2").with.agentConfig.instructions).toContain("verdict-1.json");
		// gate grounds objective criteria: build always, tests for code profiles
		expect(get("gate").with.command).toContain("library|service)");
		expect(get("gate").with.command).toContain("WFB_TEST");
		// read_verdict aggregates verdict-*.json mode-agnostically
		const rv = get("read_verdict");
		expect(rv.with.command).toContain("verdict-*.json");
		expect(rv.with.command).toContain("recommend_restart");
	});

	it("contract negotiation tags criteria objective|subjective with profile-aware dims", () => {
		const spec = loadFixture();
		const neg = spec.do.find((e: any) => e.negotiate)?.negotiate;
		const review = neg.do.find((e: any) => e.review)?.review;
		expect(review.with.agentConfig.instructions).toContain("kind");
		const rc = neg.do.find((e: any) => e.read_contract)?.read_contract;
		expect(rc.with.command).toContain(".wfb_profile"); // profile-aware dim()
		expect(rc.with.command).toContain("_CODEDIMS");
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
