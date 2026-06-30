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
    expect(ids).toEqual(["enter_dev_mode", "plan", "design_review", "plan_artifact", "refine", "summary"]);
    const refine = spec().do.find((n: any) => n.refine).refine;
    expect(refine.do.map((n: any) => Object.keys(n)[0])).toEqual(["generate", "snapshot", "critique"]);
  });
  it("exposes per-CLI inputs in both schema blocks", () => {
    const s = spec();
    for (const block of [
      s.document["x-workflow-builder"].input.schema.document.properties,
      s.input.schema.document.properties,
    ]) {
      expect(block.generatorAgent?.default).toBe("claude-code-cli");
      expect(block.criticAgent?.default).toBe("cli-playwright-critic-agent");
      expect(block.targetRoute?.default).toBe("/");
      expect(block.previewLogin?.default).toBe("preview@local");
    }
  });
  it("threads the contract via .plan and grades against it", () => {
    const refine = spec().do.find((n: any) => n.refine).refine;
    const critique = refine.do.find((n: any) => n.critique).critique;
    expect(critique.parseJson).toBe(true);
    expect(critique.with.body.prompt).toContain(".plan | tojson");
    const plan = spec().do.find((n: any) => n.plan).plan;
    expect(plan.parseJson).toBe(true);
  });
});
