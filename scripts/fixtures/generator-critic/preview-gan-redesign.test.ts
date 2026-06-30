import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { specToGraph } from "../../../src/lib/utils/spec-graph-adapter";

const fixturePath = resolve(process.cwd(), "scripts/fixtures/generator-critic/preview-gan-redesign.json");
const spec = () => JSON.parse(readFileSync(fixturePath, "utf8"));

describe("preview-gan-redesign fixture", () => {
  it("builds a valid canvas graph", () => {
    const g = specToGraph(spec());
    expect(g.nodes.length).toBeGreaterThan(5);
  });
  it("has the V2-simplified GAN node sequence", () => {
    const ids = spec().do.map((n: any) => Object.keys(n)[0]);
    expect(ids).toEqual(["enter_dev_mode", "plan", "design_review", "refine", "summary"]);
    const refine = spec().do.find((n: any) => n.refine).refine;
    expect(refine.do.map((n: any) => Object.keys(n)[0])).toEqual(["generate", "snapshot", "critique"]);
  });
  it("exposes per-CLI inputs in both schema blocks", () => {
    const s = spec();
    for (const block of [
      s.document["x-workflow-builder"].input.schema.document.properties,
      s.input.schema.document.properties,
    ]) {
      expect(block.planAgent?.default).toBe("gan-planner-claude");
      expect(block.generatorAgent?.default).toBe("gan-generator-claude");
      expect(block.criticAgent?.default).toBe("gan-critic-claude");
      expect(block.targetRoute?.default).toBe("/dashboard");
      expect(block.previewLogin?.default).toBe("admin@example.com");
    }
  });
  it("shares the contract via a /sandbox/work file and grades against it (no cross-node parseJson refs in the loop)", () => {
    const refine = spec().do.find((n: any) => n.refine).refine;
    const critique = refine.do.find((n: any) => n.critique).critique;
    expect(critique.parseJson).toBe(true); // verdict drives .loop.accepted
    // contract is read from the shared file, not threaded via .plan cross-node refs
    expect(critique.with.agentConfig.instructions).toContain("/sandbox/work/contract.json");
    const generate = refine.do.find((n: any) => n.generate).generate;
    expect(generate.with.agentConfig.instructions).toContain("/sandbox/work/contract.json");
    // the loop prompts must NOT reference .plan/.design_review (excluded from loop jq context)
    expect(JSON.stringify(refine)).not.toContain(".plan");
    expect(JSON.stringify(refine)).not.toContain(".design_review");
    const plan = spec().do.find((n: any) => n.plan).plan;
    expect(plan.with.agentConfig.instructions).toContain("/sandbox/work/contract.json");
  });
});
