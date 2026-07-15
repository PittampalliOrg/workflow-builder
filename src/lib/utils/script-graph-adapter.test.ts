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
    const labels = m.calls
      .filter((c) => c.kind === "agent")
      .map((c) => c.label);
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
    const m = parseScriptStructure(
      'await workflow("deep-research", { q: 1 });',
    );
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

  it("ignores agent()/parallel()/pipeline() tokens inside prompt strings", () => {
    // A prompt that documents the dialect must NOT spawn phantom calls (the
    // real trace-deep-analysis synthesis prompt does exactly this).
    const m = parseScriptStructure(
      'phase("Go");\n' +
        "const r = await agent(\n" +
        '  "Follow the dialect: agent()/parallel()/pipeline()/phase()/log() — always await.",\n' +
        '  { label: "worker", schema: { type: "object", properties: { ok: {} } } }\n' +
        ");",
    );
    expect(m.calls.map((c) => c.kind)).toEqual(["agent"]);
    expect(m.calls[0].label).toBe("worker");
    expect(m.calls[0].schemaProps).toEqual(["ok"]);
    expect(m.estimatedAgentCalls).toBe(1);
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
    const variants = nodes
      .map((n) => (n.data as { variant: string }).variant)
      .filter((v) => !v.endsWith("Group"));
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
      (e) =>
        e.source === junction.id &&
        (e.data as { parallel?: boolean })?.parallel,
    );
    expect(out).toHaveLength(2);
    const members = out.map((e) => e.target);
    // both members fan into the Verdict phase (same downstream target)
    const proTargets = edges
      .filter((e) => e.source === members[0])
      .map((e) => e.target);
    const conTargets = edges
      .filter((e) => e.source === members[1])
      .map((e) => e.target);
    expect(proTargets).toEqual(conTargets);
    expect(proTargets[0]).toBe("phase-Verdict");
  });

  it("renders one column per resolved ARR.map() element, labeled", () => {
    const { nodes } = scriptToGraph(FAN_OUT);
    const cols = nodes.filter(
      (n) => typeof n.id === "string" && n.id.includes("-fan-"),
    );
    expect(cols).toHaveLength(3);
    const labels = cols.map((n) => (n.data as { label: string }).label);
    expect(labels).toEqual(["perf", "cost", "risk"]);
  });

  it("gives every node a uniform width", () => {
    const { nodes } = scriptToGraph(PROS_CONS);
    const widths = new Set(
      nodes
        .filter(
          (n) =>
            !String((n.data as { variant: string }).variant).endsWith("Group"),
        )
        .map((n) => (n.data as { width?: number }).width),
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

describe("call-site lines (P2b overlay join key)", () => {
  it("calls carry 1-based source lines matching the stored source", () => {
    const script = [
      "export const meta = { name: 'l', description: 'd', phases: [] }",
      "// comment",
      "const a = await agent('one')",
      "const r = await parallel([() => agent('two'), () => agent('three')])",
      "return { a, r }",
    ].join("\n");
    const model = parseScriptStructure(script, { name: "l" });
    const byLabel = Object.fromEntries(
      model.calls.map((c) => [c.label, c.line]),
    );
    expect(byLabel.one).toBe(3);
    expect(model.calls.find((c) => c.kind === "parallel")?.line).toBe(4);
    expect(byLabel.two).toBe(4);
  });

  it("line survives comment stripping (newlines preserved)", () => {
    const script =
      "export const meta = { name: 'c', description: 'd', phases: [] }\n" +
      "/* block\ncomment\n*/\n" +
      "const a = await agent('after-block')\nreturn { a }";
    const model = parseScriptStructure(script, { name: "c" });
    expect(model.calls[0].line).toBe(5);
  });

  it("node data carries the line for the overlay join", () => {
    const script =
      "export const meta = { name: 'n', description: 'd', phases: [] }\n" +
      "const a = await agent('solo')\nreturn { a }";
    const { nodes } = scriptToGraph(script, { name: "n" });
    const agentNode = nodes.find(
      (n) => (n.data as { variant?: string }).variant === "agent",
    );
    expect((agentNode?.data as { line?: number }).line).toBe(2);
  });
});

// ── Adapter v2: full dialect coverage (code-first canvas redesign) ───────────

describe("full dialect kinds (action/sleep/event/team)", () => {
  const script = [
    "export const meta = { name: 'full', phases: [{ title: 'Main' }], input: { type: 'object', properties: { url: {}, depth: {} } } }",
    "phase('Main')",
    "const crawl = await action('web/crawl', { url: args.url }, { label: 'crawl', allowFailure: true })",
    "await sleep(30)",
    "const gate = await approve({ message: 'Ship the crawl summary?', timeoutMinutes: 60 })",
    "const evt = await waitForEvent('deploy-finished')",
    "const t = await team.spawn({ name: 'reviewers' })",
    "await team.task('reviewer', 'Review the crawl output')",
    "const res = await agent('Summarize', { agent: 'trace-analyst', agentVersion: 3, model: 'zai/glm-5.2', sandbox: { workspaceRef: 'x' } })",
    "return { res }",
  ].join("\n");

  it("detects every call kind with its specifics", () => {
    const m = parseScriptStructure(script, {
      name: "full",
      input: { properties: { url: {}, depth: {} } },
    });
    const kinds = m.calls.map((c) => c.kind);
    expect(kinds).toEqual([
      "action",
      "sleep",
      "event",
      "event",
      "team",
      "team",
      "agent",
    ]);

    const [act, slp, appr, evt, spawn, task, ag] = m.calls;
    expect(act.actionSlug).toBe("web/crawl");
    expect(act.allowFailure).toBe(true);
    expect(act.label).toBe("crawl");
    expect(slp.sleepSeconds).toBe(30);
    expect(appr.eventName).toBe("approval");
    expect(appr.label).toContain("Ship the crawl");
    expect(evt.eventName).toBe("deploy-finished");
    expect(spawn.teamOp).toBe("spawn");
    expect(task.teamOp).toBe("task");
    expect(ag.agentRef).toBe("trace-analyst");
    expect(ag.model).toBe("zai/glm-5.2");
    expect(ag.hasSandbox).toBe(true);
  });

  it("exposes meta.input property names on the model", () => {
    const m = parseScriptStructure(script, {
      input: { properties: { url: {}, depth: {} } },
    });
    expect(m.inputProps).toEqual(["url", "depth"]);
  });

  it("graph emits nodes for the new kinds with call data", () => {
    const { nodes } = scriptToGraph(script, { name: "full" });
    const byKind = (k: string) => nodes.filter((n) => n.data.kind === k);
    expect(byKind("action")).toHaveLength(1);
    expect(byKind("sleep")).toHaveLength(1);
    expect(byKind("event")).toHaveLength(2);
    expect(byKind("team")).toHaveLength(2);
    const action = byKind("action")[0];
    expect(action.data.actionSlug).toBe("web/crawl");
    expect(action.data.allowFailure).toBe(true);
    expect(typeof action.data.line).toBe("number");
  });
});

describe("loop containers + loop-back edges", () => {
  const script = [
    "phase('Refine')",
    "let ok = false",
    "let i = 0",
    "while (!ok && i < 5) {",
    "  await agent('Generate', { label: 'generate' })",
    "  const gate = await action('workspace/command', { command: 'test' }, { label: 'gate', allowFailure: true })",
    "  const verdict = await agent('Critique', { label: 'critique', schema: { type: \"object\" } })",
    "  ok = verdict?.accepted === true",
    "  i += 1",
    "}",
    "return { ok }",
  ].join("\n");

  it("identifies the loop and its member calls", () => {
    const m = parseScriptStructure(script);
    expect(m.loops).toHaveLength(1);
    expect(m.loops[0].kind).toBe("while");
    const inLoop = m.calls.filter((c) => c.loopId === m.loops[0].id);
    expect(inLoop.map((c) => c.label)).toEqual([
      "generate",
      "gate",
      "critique",
    ]);
  });

  it("emits ONE loop-back edge from the last member to the first", () => {
    const { edges, model } = scriptToGraph(script);
    const loopEdges = edges.filter(
      (e) => (e.data as { loop?: boolean } | undefined)?.loop,
    );
    expect(loopEdges).toHaveLength(1);
    const members = model.calls.filter((c) => c.loopId === model.loops[0].id);
    expect(loopEdges[0].source).toBe(
      `call-${members[members.length - 1].order}`,
    );
    expect(loopEdges[0].target).toBe(`call-${members[0].order}`);
  });
});

describe("prompt strings cannot fake the new kinds", () => {
  it("action(/sleep( inside a prompt string are NOT calls", () => {
    const m = parseScriptStructure(
      "await agent('Explain how action(\\'x\\') and sleep(5) work in scripts')",
    );
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].kind).toBe("agent");
  });
});

describe("argUsage (run-parameterization captions)", () => {
  it("maps args.X to the labels of consuming calls (incl. template interpolations)", () => {
    const m = parseScriptStructure(
      [
        "const crawl = await action('web/crawl', { url: args.url }, { label: 'crawl' })",
        "await agent('review it', { label: 'review', agent: args.reviewAgent })",
        "await agent(`use ${args.url}`, { label: 'summarize' })",
      ].join("\n"),
    );
    expect(m.argUsage.url).toEqual(["crawl", "summarize"]);
    expect(m.argUsage.reviewAgent).toEqual(["review"]);
  });
});

describe("semantic containers", () => {
  it("wraps loop members in a loopGroup parent with rebased child positions", () => {
    const src = `export const meta = { name: 'l' }
let done = false
while (!done) {
  const draft = await agent('write')
  const crit = await agent('critique')
  done = crit.ok
}
return 1`;
    const { nodes } = scriptToGraph(src);
    const grp = nodes.find(
      (n) => (n.data as { variant: string }).variant === "loopGroup",
    )!;
    expect(grp).toBeTruthy();
    expect((grp.data as { caption: string }).caption).toMatch(/repeats/);
    const children = nodes.filter(
      (n) => (n as { parentId?: string }).parentId === grp.id,
    );
    expect(children.length).toBe(2);
    for (const c of children) {
      expect(c.position.x).toBeGreaterThanOrEqual(0);
      expect(c.position.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("wraps parallel junction + branches in a parallelGroup container", () => {
    const { nodes } = scriptToGraph(PROS_CONS);
    const grp = nodes.find(
      (n) => (n.data as { variant: string }).variant === "parallelGroup",
    )!;
    expect(grp).toBeTruthy();
    expect((grp.data as { label: string }).label).toMatch(/parallel ×2/);
    const children = nodes.filter(
      (n) => (n as { parentId?: string }).parentId === grp.id,
    );
    expect(children.length).toBe(3); // junction + 2 branches
  });
});

describe("nested containers", () => {
  it("a parallel inside a loop nests pargrp under loopgrp without double containment", () => {
    const src = `export const meta = { name: 'n' }
let ok = false
while (!ok) {
  const votes = await parallel([
    () => agent('judge a'),
    () => agent('judge b'),
  ])
  const merged = await agent('merge votes')
  ok = merged.ok
}
return 1`;
    const { nodes } = scriptToGraph(src);
    const loopGrp = nodes.find(
      (n) => (n.data as { variant: string }).variant === "loopGroup",
    )!;
    const parGrp = nodes.find(
      (n) => (n.data as { variant: string }).variant === "parallelGroup",
    )! as { id: string; parentId?: string };
    expect(loopGrp).toBeTruthy();
    expect(parGrp).toBeTruthy();
    expect(parGrp.parentId).toBe(loopGrp.id);
    // junction + branch columns belong to the parallel group, not the loop
    const parChildren = nodes.filter(
      (n) => (n as { parentId?: string }).parentId === parGrp.id,
    );
    expect(parChildren.length).toBe(3);
    // the merge call sits directly in the loop group
    const loopChildren = nodes.filter(
      (n) => (n as { parentId?: string }).parentId === loopGrp.id,
    );
    expect(
      loopChildren.some((n) =>
        (n.data as { label?: string }).label?.includes("merge"),
      ),
    ).toBe(true);
    // parents precede children in the array (SvelteFlow contract)
    const idx = (id: string) => nodes.findIndex((n) => n.id === id);
    expect(idx(loopGrp.id)).toBeLessThan(idx(parGrp.id));
  });
});
