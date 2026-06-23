import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { specToGraph } from "../../../src/lib/utils/spec-graph-adapter";

const fixturePath = resolve(
	process.cwd(),
	"scripts/fixtures/generator-critic/gan-harness-dapr-showcase.json",
);

function loadFixture(): any {
	return JSON.parse(readFileSync(fixturePath, "utf8"));
}

// Recursively walk every node in a do[] (including nested do / for.do sub-tasks).
function walkNodes(do_: any[], visit: (name: string, node: any) => void) {
	for (const entry of do_ ?? []) {
		for (const [name, node] of Object.entries(entry) as [string, any][]) {
			if (!node || typeof node !== "object") continue;
			visit(name, node);
			if (Array.isArray(node.do)) walkNodes(node.do, visit);
			if (node.for && Array.isArray(node.for.do)) walkNodes(node.for.do, visit);
		}
	}
}

describe("GAN harness dapr-agent-py showcase fixture (openshell-shared backend)", () => {
	it("defaults all three agent slots to the dapr evaluator-critic-agent (both schema blocks)", () => {
		const spec = loadFixture();
		for (const block of [
			spec.document["x-workflow-builder"].input.schema.document.properties,
			spec.input.schema.document.properties,
		]) {
			expect(block.planAgent?.default).toBe("evaluator-critic-agent");
			expect(block.generatorAgent?.default).toBe("evaluator-critic-agent");
			expect(block.criticAgent?.default).toBe("evaluator-critic-agent");
		}
	});

	it("defaults to the code (library) profile on a small test repo", () => {
		const spec = loadFixture();
		for (const block of [
			spec.document["x-workflow-builder"].input.schema.document.properties,
			spec.input.schema.document.properties,
		]) {
			expect(block.evaluationProfile?.default).toBe("library");
			expect(block.repoUrl?.default).toBe("jonschlinkert/is-number");
		}
	});

	it("never references the CLI/JuiceFS backend (no /sandbox/work, no cliWorkspace, no cli-* agents)", () => {
		const raw = readFileSync(fixturePath, "utf8");
		expect(raw).not.toContain("/sandbox/work");
		expect(raw).not.toContain("cliWorkspace");
		expect(raw).not.toContain("cli-evaluator-critic-agent");
		expect(raw).not.toContain("cli-playwright-critic-agent");
	});

	it("provisions ONE shared openshell sandbox FIRST (workspace/profile, keepAfterRun, /sandbox root)", () => {
		const spec = loadFixture();
		expect(Object.keys(spec.do[0])[0]).toBe("workspace_profile");
		const wp = spec.do[0].workspace_profile;
		expect(wp.call).toBe("workspace/profile");
		expect(wp.with.rootPath).toBe("/sandbox");
		expect(wp.with.keepAfterRun).toBe(true);
		expect(wp.with.sandboxPolicy?.keepAfterRun).toBe(true);
	});

	it("clones the repo deterministically into /sandbox/repo with the ambient GITHUB_TOKEN", () => {
		const spec = loadFixture();
		expect(Object.keys(spec.do[1])[0]).toBe("clone_repo");
		const clone = spec.do[1].clone_repo;
		expect(clone.call).toBe("workspace/command");
		expect(clone.with.workspaceRef).toContain("workspace_profile.workspaceRef");
		expect(clone.with.command).toContain(".trigger.repoUrl");
		expect(clone.with.command).toContain("${GITHUB_TOKEN}");
		expect(clone.with.command).toContain("/sandbox/repo");
	});

	it("every durable/run agent binds the shared sandbox (sandboxName + workspaceRef + sandboxPolicy, /sandbox cwd)", () => {
		const spec = loadFixture();
		let agentNodes = 0;
		walkNodes(spec.do, (name, node) => {
			if (node.call !== "durable/run") return;
			agentNodes++;
			expect(node.with?.sandboxName, `${name} sandboxName`).toContain(
				"workspace_profile.sandboxName",
			);
			expect(node.with?.workspaceRef, `${name} workspaceRef`).toContain(
				"workspace_profile.workspaceRef",
			);
			expect(node.with?.sandboxPolicy, `${name} sandboxPolicy`).toBeTruthy();
			if (node.with?.cwd) expect(node.with.cwd, `${name} cwd`).toMatch(/^\/sandbox/);
		});
		expect(agentNodes).toBeGreaterThanOrEqual(8); // plan + design x2 + negotiate x2 + generate + evaluators
	});

	it("every workspace/command targets the shared sandbox by workspaceRef (and none is cliWorkspace)", () => {
		const spec = loadFixture();
		let cmdNodes = 0;
		walkNodes(spec.do, (name, node) => {
			if (node.call !== "workspace/command") return;
			cmdNodes++;
			expect(node.with?.workspaceRef, `${name} workspaceRef`).toContain(
				"workspace_profile.workspaceRef",
			);
			expect(node.with?.cliWorkspace, `${name} cliWorkspace`).toBeUndefined();
		});
		expect(cmdNodes).toBeGreaterThanOrEqual(9); // clone + init + spine
	});

	it("the planner no longer clones — it reads the already-cloned /sandbox/repo and writes /sandbox/SPEC.md", () => {
		const spec = loadFixture();
		const plan = spec.do.find((e: any) => e.plan)?.plan;
		expect(plan.with.body.prompt).toContain("ALREADY cloned");
		expect(plan.with.body.prompt).toContain("/sandbox/SPEC.md");
		expect(plan.with.body.prompt).not.toContain("git clone");
		expect(plan.with.agentConfig.instructions).toContain("/sandbox/repo");
	});

	it("restart authority is bounded by maxRestarts, plumbed via the .wfb_maxrestarts dotfile (not a hybrid ${} command)", () => {
		const spec = loadFixture();
		const init = spec.do.find((e: any) => e.init_state)?.init_state;
		expect(init.with.command).toContain("/sandbox/.wfb_maxrestarts");
		const refine = spec.do.find((e: any) => e.refine)?.refine;
		const mr = refine.do.find((e: any) => e.maybe_restart)?.maybe_restart;
		// must be a pure literal shell (full-string-${} rule) — NOT a `${jq}literal` hybrid
		expect(mr.with.command.trimStart().startsWith("${")).toBe(false);
		expect(mr.with.command).toContain("/sandbox/.wfb_maxrestarts");
		expect(mr.with.command).toContain("WFB_MAXRESTARTS");
		expect(mr.with.command).toContain("reset");
		expect(mr.with.command).toContain("--hard");
		expect(mr.if).toContain("maxRestarts");
	});

	it("carries over the full GAN structure (design two-pass, refine loop, profile-agnostic read_contract)", () => {
		const spec = loadFixture();
		// design two-pass loop, gated to ui-web (skipped for the library default)
		const design = spec.do.find((e: any) => e.design)?.design;
		expect(design.do.map((e: any) => Object.keys(e)[0])).toEqual([
			"design_propose",
			"design_review",
			"design_read",
		]);
		// refine build loop
		const refine = spec.do.find((e: any) => e.refine)?.refine;
		expect(refine.do.map((e: any) => Object.keys(e)[0])).toEqual([
			"generate",
			"gate",
			"evaluate_ui",
			"evaluate_code",
			"evaluate_ui_2",
			"evaluate_code_2",
			"read_verdict",
			"maybe_restart",
		]);
		// code evaluator runs the suite, no browser
		const get = (n: string) => refine.do.find((e: any) => e[n])?.[n];
		expect(get("evaluate_code").if).toContain('!= "ui-web"');
		expect(get("evaluate_code").with.agentConfig.instructions).toContain("do NOT open a browser");
		// read_contract stays profile-agnostic
		const neg = spec.do.find((e: any) => e.negotiate)?.negotiate;
		const rc = neg.do.find((e: any) => e.read_contract)?.read_contract;
		expect(rc.with.command).not.toContain(".wfb_profile");
		expect(rc.with.command).toContain("_ALLDIMS");
		// publish_shot (Playwright) stays gated to ui-web → skipped for library
		const ps = spec.do.find((e: any) => e.publish_shot)?.publish_shot;
		expect(ps.if).toContain("ui-web");
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
