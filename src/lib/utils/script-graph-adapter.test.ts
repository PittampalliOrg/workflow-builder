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

const FAN_OUT = `
export const meta = { name: "review", phases: [{ title: "Review" }, { title: "Sum" }] }
const LENSES = [{ key: "perf" }, { key: "cost" }, { key: "risk" }];
phase("Review");
const reviews = await parallel(
  LENSES.map((l) => () => agent("Review via " + l.key, { schema: FINDINGS })),
);
const FINDINGS = { type: "object", properties: { findings: {}, score: {} } };
phase("Sum");
const report = await agent("Summarize.", {
  schema: { type: "object", properties: { summary: {}, health: {}, actions: {} } },
});
return report;
`;

describe("parseScriptStructure", () => {
  it("extracts name, declared+discovered phases, and calls in order", () => {
    const m = parseScriptStructure(PROS_CONS, {
      name: "pros-cons",
      phases: [{ title: "Debate" }, { title: "Verdict" }],
    });
    expect(m.name).toBe("pros-cons");
    expect(m.phases).toEqual(["Debate", "Verdict"]);
    expect(m.calls.map((c) => c.kind)).toEqual([
      "parallel",
      "agent",
      "agent",
      "agent",
    ]);
    expect(m.estimatedAgentCalls).toBe(3);
  });

  it("assigns parallel members to their enclosing group", () => {
    const m = parseScriptStructure(PROS_CONS);
    const parallel = m.calls.find((c) => c.kind === "parallel")!;
    const pro = m.calls.find((c) => c.label === "pro")!;
    const con = m.calls.find((c) => c.label === "con")!;
    const judge = m.calls.find((c) => c.label === "judge")!;
    expect(parallel.groupId).toBeTruthy();
    expect(pro.parentGroup).toBe(parallel.groupId);
    expect(con.parentGroup).toBe(parallel.groupId);
    expect(judge.parentGroup).toBeNull();
  });

  it("resolves an ARR.map() fan-out to element count + labels", () => {
    const m = parseScriptStructure(FAN_OUT);
    const parallel = m.calls.find((c) => c.kind === "parallel")!;
    expect(parallel.fanOut).toEqual({
      count: 3,
      labels: ["perf", "cost", "risk"],
    });
  });

  it("captures agent prompt preview + schema property names", () => {
    const m = parseScriptStructure(FAN_OUT);
    const report = m.calls.find((c) => c.promptPreview === "Summarize.")!;
    expect(report.hasSchema).toBe(true);
    expect(report.schemaProps).toEqual(["summary", "health", "actions"]);
    const reviewer = m.calls.find((c) => c.parentGroup)!;
    expect(reviewer.hasSchema).toBe(true);
    // named schema resolved from the const definition
    expect(reviewer.schemaProps).toEqual(["findings", "score"]);
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
});

describe("scriptToGraph", () => {
  const byId = (nodes: { id: string }[], id: string) =>
    nodes.find((n) => n.id === id);
  const variantOf = (n: { data: unknown } | undefined) =>
    (n?.data as { variant?: string } | undefined)?.variant;

  it("builds Start → phases → End with a parallel junction + fanned columns", () => {
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
    expect(nodes.every((n) => n.type === SCRIPT_NODE_TYPE)).toBe(true);
    expect(byId(nodes, "phase-Debate")).toBeTruthy();
    expect(byId(nodes, "phase-Verdict")).toBeTruthy();
  });

  it("fans a parallel junction out to its members and back into the next node", () => {
    const { nodes, edges } = scriptToGraph(PROS_CONS);
    const junction = nodes.find((n) => variantOf(n) === "parallel")!;
    // two parallel edges out of the junction (pro + con)
    const out = edges.filter(
      (e) => e.source === junction.id && (e.data as { parallel?: boolean })?.parallel,
    );
    expect(out).toHaveLength(2);
    const members = out.map((e) => e.target);
    // both members fan into the Verdict phase (same downstream target)
    const proTargets = edges.filter((e) => e.source === members[0]).map((e) => e.target);
    const conTargets = edges.filter((e) => e.source === members[1]).map((e) => e.target);
    expect(proTargets).toEqual(conTargets);
    expect(proTargets[0]).toBe("phase-Verdict");
  });

  it("renders one column per resolved ARR.map() element, labeled", () => {
    const { nodes } = scriptToGraph(FAN_OUT);
    const cols = nodes.filter((n) =>
      typeof n.id === "string" && n.id.includes("-fan-"),
    );
    expect(cols).toHaveLength(3);
    const labels = cols.map((n) => (n.data as { label: string }).label);
    expect(labels).toEqual(["perf", "cost", "risk"]);
  });

  it("gives every node a uniform width", () => {
    const { nodes } = scriptToGraph(PROS_CONS);
    const widths = new Set(
      nodes.map((n) => (n.data as { width?: number }).width),
    );
    expect(widths).toEqual(new Set([264]));
  });

  it("collects unphased calls under a '(no phase)' lane", () => {
    const { nodes } = scriptToGraph('await agent("free", { label: "F" });');
    const phaseNode = nodes.find((n) => variantOf(n) === "phase");
    expect((phaseNode?.data as { label?: string })?.label).toBe("(no phase)");
  });

  it("marks start/end non-selectable and disables dragging", () => {
    const { nodes } = scriptToGraph(PROS_CONS);
    const start = nodes.find((n) => n.id === "__start__");
    expect(start?.draggable).toBe(false);
    expect(start?.selectable).toBe(false);
  });
});
