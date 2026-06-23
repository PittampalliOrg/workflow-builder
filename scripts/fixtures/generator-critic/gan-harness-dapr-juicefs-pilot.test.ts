import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { specToGraph } from "../../../src/lib/utils/spec-graph-adapter";

const fixturePath = resolve(
	process.cwd(),
	"scripts/fixtures/generator-critic/gan-harness-dapr-juicefs-pilot.json",
);

function loadFixture(): any {
	return JSON.parse(readFileSync(fixturePath, "utf8"));
}

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

describe("GAN harness dapr-agent-py-juicefs PILOT fixture", () => {
	it("defaults all three agent slots to the dapr-juicefs agent (both schema blocks)", () => {
		const spec = loadFixture();
		for (const block of [
			spec.document["x-workflow-builder"].input.schema.document.properties,
			spec.input.schema.document.properties,
		]) {
			expect(block.planAgent?.default).toBe("dapr-juicefs-evaluator-critic-agent");
			expect(block.generatorAgent?.default).toBe("dapr-juicefs-evaluator-critic-agent");
			expect(block.criticAgent?.default).toBe("dapr-juicefs-evaluator-critic-agent");
		}
	});

	it("defaults to the library code profile on a small test repo (master branch)", () => {
		const spec = loadFixture();
		for (const block of [
			spec.document["x-workflow-builder"].input.schema.document.properties,
			spec.input.schema.document.properties,
		]) {
			expect(block.evaluationProfile?.default).toBe("library");
			expect(block.repoUrl?.default).toBe("jonschlinkert/is-number");
			expect(block.repoRef?.default).toBe("master");
			expect(block.outputMode?.default).toBe("none");
		}
	});

	it("uses the JuiceFS /sandbox/work backend everywhere (no openshell /sandbox or workspace_profile, no cli-* agents)", () => {
		const raw = readFileSync(fixturePath, "utf8");
		expect(raw).not.toContain("cli-evaluator-critic-agent");
		expect(raw).not.toContain("cli-playwright-critic-agent");
		expect(raw).not.toContain("workspace_profile");
		// openshell sandboxName binding must not appear (juicefs auto-mounts)
		expect(raw).not.toContain("sandboxName");
	});

	it("clones deterministically via a leading cliWorkspace node (the dapr pod has no GITHUB_TOKEN)", () => {
		const spec = loadFixture();
		expect(Object.keys(spec.do[0])[0]).toBe("clone_repo");
		const clone = spec.do[0].clone_repo;
		expect(clone.call).toBe("workspace/command");
		expect(clone.with.cliWorkspace).toBe(true);
		expect(clone.with.command).toContain("${GITHUB_TOKEN}");
		expect(clone.with.command).toContain("/sandbox/work/repo");
		expect(clone.with.command).toContain(".trigger.repoUrl");
	});

	it("the planner reads the already-cloned repo (does not clone) and writes /sandbox/work/SPEC.md", () => {
		const spec = loadFixture();
		const plan = spec.do.find((e: any) => e.plan)?.plan;
		expect(plan.with.body.prompt).toContain("ALREADY cloned at /sandbox/work/repo");
		expect(plan.with.body.prompt).toContain("/sandbox/work/SPEC.md");
		expect(plan.with.body.prompt).not.toContain("git clone");
	});

	it("every durable/run agent shares the per-execution JuiceFS mount (executionId + /sandbox/work, no sandboxPolicy)", () => {
		const spec = loadFixture();
		let agents = 0;
		walkNodes(spec.do, (name, node) => {
			if (node.call !== "durable/run") return;
			agents++;
			expect(node.with?.workspaceRef, `${name} workspaceRef`).toContain("runtime.executionId");
			expect(node.with?.sandboxPolicy, `${name} sandboxPolicy`).toBeUndefined();
			if (node.with?.cwd) expect(node.with.cwd, `${name} cwd`).toMatch(/^\/sandbox\/work/);
		});
		expect(agents).toBeGreaterThanOrEqual(8);
	});

	it("every workspace/command is cliWorkspace (routes to the JuiceFS helper, not openshell)", () => {
		const spec = loadFixture();
		let cmds = 0;
		walkNodes(spec.do, (name, node) => {
			if (node.call !== "workspace/command") return;
			cmds++;
			expect(node.with?.cliWorkspace, `${name} cliWorkspace`).toBe(true);
		});
		expect(cmds).toBeGreaterThanOrEqual(9); // clone + init + spine
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
