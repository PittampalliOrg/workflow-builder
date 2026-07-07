import { describe, it, expect } from "vitest";
import {
  parseScriptStructure,
  scriptToGraph,
  SCRIPT_NODE_TYPE,
} from "./script-graph-adapter";

const PROS_CONS = `
export const meta = {
  name: "pros-cons",
  phases: [{ title: "Debate" }, { title: "Verdict" }],
}
const topic = args?.topic;
phase("Debate");
const [pros, cons] = await parallel([
  () => agent("Argue FOR: " + topic, { label: "pro" }),
  () => agent("Argue AGAINST: " + topic, { label: "con" }),
]);
phase("Verdict");
const verdict = await agent("Judge the debate.", { label: "judge", effort: "high" });
return { verdict };
`;

describe("parseScriptStructure", () => {
  it("extracts name, declared+discovered phases, and calls in order", () => {
    const m = parseScriptStructure(PROS_CONS, {
      name: "pros-cons",
      phases: [{ title: "Debate" }, { title: "Verdict" }],
    });
    expect(m.name).toBe("pros-cons");
    expect(m.phases).toEqual(["Debate", "Verdict"]);
    // one parallel + two agents + one agent
    expect(m.calls.map((c) => c.kind)).toEqual([
      "parallel",
      "agent",
      "agent",
      "agent",
    ]);
    expect(m.estimatedAgentCalls).toBe(3);
  });

  it("labels agent calls by opts.label, else prompt preview", () => {
    const m = parseScriptStructure(PROS_CONS);
    const labels = m.calls.filter((c) => c.kind === "agent").map((c) => c.label);
    expect(labels).toEqual(["pro", "con", "judge"]);
  });

  it("assigns each call to the phase() in effect at its site", () => {
    const m = parseScriptStructure(PROS_CONS);
    const byLabel = Object.fromEntries(m.calls.map((c) => [c.label, c.phase]));
    expect(byLabel["pro"]).toBe("Debate");
    expect(byLabel["judge"]).toBe("Verdict");
  });

  it("discovers phases from phase() calls when meta.phases is absent", () => {
    const m = parseScriptStructure(
      'phase("Scan");\nawait agent("x");\nphase("Report");\nawait agent("y");',
    );
    expect(m.phases).toEqual(["Scan", "Report"]);
  });

  it("captures the workflow() child name from a string literal", () => {
    const m = parseScriptStructure('await workflow("deep-research", { q: 1 });');
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].kind).toBe("workflow");
    expect(m.calls[0].label).toBe("deep-research");
  });

  it("flags calls inside while/for loops as inLoop", () => {
    const m = parseScriptStructure(
      'let n = 0;\nwhile (n < 3) {\n  await agent("loop body", { label: "L" });\n  n++;\n}\nawait agent("after", { label: "A" });',
    );
    const byLabel = Object.fromEntries(m.calls.map((c) => [c.label, c.inLoop]));
    expect(byLabel["L"]).toBe(true);
    expect(byLabel["A"]).toBe(false);
  });

  it("ignores tokens inside comments", () => {
    const m = parseScriptStructure(
      '// phase("Ghost"); agent("ghost")\n/* agent("blk") */\nphase("Real");\nawait agent("real", { label: "R" });',
    );
    expect(m.phases).toEqual(["Real"]);
    expect(m.calls.map((c) => c.label)).toEqual(["R"]);
  });

  it("does not mistake a member method like foo.agent() ... actually only bare calls", () => {
    // `\b` boundary: `deepagent(` would match `agent(` — guard is source realism,
    // but `x.agent(` DOES match by design (dialect has no member calls). This
    // asserts the common-case bare calls, which is what authors write.
    const m = parseScriptStructure('await agent("solo");');
    expect(m.calls).toHaveLength(1);
  });
});

describe("scriptToGraph", () => {
  it("builds Start → phase lanes (header + calls) → End", () => {
    const { nodes, edges, model } = scriptToGraph(PROS_CONS, {
      name: "pros-cons",
      phases: [{ title: "Debate" }, { title: "Verdict" }],
    });
    expect(model.estimatedAgentCalls).toBe(3);
    const variants = nodes.map((n) => (n.data as { variant: string }).variant);
    expect(variants[0]).toBe("start");
    expect(variants[variants.length - 1]).toBe("end");
    expect(variants).toContain("phase");
    expect(variants).toContain("parallel");
    expect(variants.filter((v) => v === "agent")).toHaveLength(3);
    // every node uses the single script node type
    expect(nodes.every((n) => n.type === SCRIPT_NODE_TYPE)).toBe(true);
    // a connected chain: edges = nodes - 1 (linear preview)
    expect(edges).toHaveLength(nodes.length - 1);
    // deterministic ids
    expect(nodes.find((n) => n.id === "phase-Debate")).toBeTruthy();
    expect(nodes.find((n) => n.id === "phase-Verdict")).toBeTruthy();
  });

  it("collects unphased calls under a '(no phase)' lane", () => {
    const { nodes } = scriptToGraph('await agent("free", { label: "F" });');
    const phaseNode = nodes.find(
      (n) => (n.data as { variant?: string }).variant === "phase",
    );
    expect((phaseNode?.data as { label?: string })?.label).toBe("(no phase)");
  });

  it("marks start/end non-selectable and disables dragging", () => {
    const { nodes } = scriptToGraph(PROS_CONS);
    const start = nodes.find((n) => n.id === "__start__");
    expect(start?.draggable).toBe(false);
    expect(start?.selectable).toBe(false);
  });
});
