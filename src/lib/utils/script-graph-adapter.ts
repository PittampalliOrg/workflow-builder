/**
 * Dynamic-script → canvas graph adapter.
 *
 * The dynamic-script engine's "spec" IS a JavaScript orchestration script
 * (the Claude Code Workflow dialect: `phase()`, `agent()`, `parallel()`,
 * `pipeline()`, `workflow()`), not an SW 1.0 node graph. This adapter derives a
 * READ-ONLY structural preview of that script for the SvelteFlow canvas so a
 * dynamic-script workflow finally shows its shape (today it renders nothing).
 *
 * It is a lightweight STATIC scan, not an execution — the true call graph only
 * exists at run time (the journal). So it groups calls by the `phase()` marker
 * they appear under and renders one node per detected orchestration call,
 * clearly framed as a "structure preview". Dynamic loops / conditionals are
 * annotated (inLoop) rather than unrolled. The counterpart `specToGraph`
 * (spec-graph-adapter.ts) handles SW 1.0; this handles `engine: 'dynamic-script'`.
 */

import type { Node, Edge } from "@xyflow/svelte";

export type ScriptGraphCallKind = "agent" | "parallel" | "pipeline" | "workflow";

/** SvelteFlow node type used for every dynamic-script node (one component). */
export const SCRIPT_NODE_TYPE = "script";

export type ScriptNodeVariant =
  | "start"
  | "phase"
  | "agent"
  | "parallel"
  | "pipeline"
  | "workflow"
  | "end";

export interface ScriptGraphCall {
  kind: ScriptGraphCallKind;
  /** Short human label — an opts.label / workflow name / prompt preview. */
  label: string;
  /** The phase() title in effect at the call site, or null. */
  phase: string | null;
  /** The call appears inside a while/for loop (so it may run N times). */
  inLoop: boolean;
  /** Source order index (stable). */
  order: number;
}

export interface ScriptGraphModel {
  name: string;
  /** Declared (meta.phases) ∪ discovered phase() titles, in first-seen order. */
  phases: string[];
  calls: ScriptGraphCall[];
  /** agent() call sites (matches the evaluator's estimatedAgentCalls intent). */
  estimatedAgentCalls: number;
}

/** Strip line + block comments so token scans don't match commented-out code.
 * String contents are preserved (we need phase()/workflow() literal names). */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  type Mode = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  let mode: Mode = "code";
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (mode === "code") {
      if (c === "/" && c2 === "/") {
        mode = "line";
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        mode = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "'") mode = "sq";
      else if (c === '"') mode = "dq";
      else if (c === "`") mode = "tpl";
      out += c;
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out += c;
      }
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && c2 === "/") {
        mode = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    // string modes: copy verbatim, honor escapes, exit on the closing quote
    out += c;
    if (c === "\\") {
      out += c2 ?? "";
      i += 2;
      continue;
    }
    if (
      (mode === "sq" && c === "'") ||
      (mode === "dq" && c === '"') ||
      (mode === "tpl" && c === "`")
    ) {
      mode = "code";
    }
    i += 1;
  }
  return out;
}

const PHASE_TITLES_FROM_META = (meta: unknown): string[] => {
  const phases = (meta as { phases?: unknown } | null | undefined)?.phases;
  if (!Array.isArray(phases)) return [];
  const out: string[] = [];
  for (const p of phases) {
    if (typeof p === "string" && p.trim()) out.push(p.trim());
    else if (
      p &&
      typeof p === "object" &&
      typeof (p as { title?: unknown }).title === "string" &&
      (p as { title: string }).title.trim()
    ) {
      out.push((p as { title: string }).title.trim());
    }
  }
  return out;
};

/** Read a string-literal argument starting at `open` (index of `(`). Returns
 * the literal text (without quotes) if the FIRST argument is a plain string /
 * template with no interpolation, else null. */
function firstStringArg(src: string, open: number): string | null {
  let i = open + 1;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  const q = src[i];
  if (q !== "'" && q !== '"' && q !== "`") return null;
  let out = "";
  i += 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      out += src[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (q === "`" && c === "$" && src[i + 1] === "{") return null; // interpolated
    if (c === q) return out;
    out += c;
    i += 1;
  }
  return null;
}

/** Read an `opts.label` string literal from the call's argument span. Scans
 * only up to the matching close paren so it never crosses into the next call. */
function labelFromOpts(src: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  // Bounded window from open to the close (or +2000 chars).
  let end = open;
  let d = 0;
  for (; end < src.length; end += 1) {
    if (src[end] === "(") d += 1;
    else if (src[end] === ")") {
      d -= 1;
      if (d === 0) {
        end += 1;
        break;
      }
    }
  }
  const span = src.slice(open, end);
  const m = span.match(/label\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/);
  return m ? m[2] : null;
}

function truncate(s: string, max = 48): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

/**
 * Parse a dynamic-script source into its structural model (phases + calls).
 * Pure + deterministic — safe to run anywhere (no execution).
 */
export function parseScriptStructure(
  script: string,
  meta?: unknown,
): ScriptGraphModel {
  const src = stripComments(String(script ?? ""));
  const declaredPhases = PHASE_TITLES_FROM_META(meta);
  const name =
    (meta as { name?: unknown } | null | undefined)?.name &&
    typeof (meta as { name: unknown }).name === "string"
      ? (meta as { name: string }).name
      : "dynamic-script";

  // Precompute loop spans (while/for bodies) so we can flag calls inside them.
  const loopSpans: Array<[number, number]> = [];
  const loopKw = /\b(while|for)\s*\(/g;
  let lm: RegExpExecArray | null;
  while ((lm = loopKw.exec(src))) {
    // find the loop body `{ ... }` after the condition
    let i = lm.index + lm[0].length;
    let d = 1;
    for (; i < src.length && d > 0; i += 1) {
      if (src[i] === "(") d += 1;
      else if (src[i] === ")") d -= 1;
    }
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] !== "{") continue;
    let bd = 1;
    const bodyStart = i;
    i += 1;
    for (; i < src.length && bd > 0; i += 1) {
      if (src[i] === "{") bd += 1;
      else if (src[i] === "}") bd -= 1;
    }
    loopSpans.push([bodyStart, i]);
  }
  const inLoopAt = (pos: number) =>
    loopSpans.some(([a, b]) => pos >= a && pos < b);

  // Single ordered scan for phase()/agent()/parallel()/pipeline()/workflow().
  const tokenRe = /\b(phase|agent|parallel|pipeline|workflow)\s*\(/g;
  const discoveredPhases: string[] = [];
  const calls: ScriptGraphCall[] = [];
  let currentPhase: string | null = null;
  let order = 0;
  let tm: RegExpExecArray | null;
  while ((tm = tokenRe.exec(src))) {
    const kind = tm[1] as "phase" | ScriptGraphCallKind;
    const open = tm.index + tm[0].length - 1; // index of "("
    if (kind === "phase") {
      const title = firstStringArg(src, open);
      if (title) {
        currentPhase = title;
        if (!discoveredPhases.includes(title)) discoveredPhases.push(title);
      }
      continue;
    }
    let label: string;
    if (kind === "workflow") {
      const wfName = firstStringArg(src, open);
      label = wfName ? wfName : "workflow()";
    } else {
      const optLabel = labelFromOpts(src, open);
      if (optLabel) label = optLabel;
      else {
        const promptArg = firstStringArg(src, open);
        label = promptArg ? truncate(promptArg) : `${kind}()`;
      }
    }
    calls.push({
      kind,
      label,
      phase: currentPhase,
      inLoop: inLoopAt(open),
      order: order++,
    });
  }

  // Union of declared + discovered phases, preserving declared order first.
  const phases: string[] = [...declaredPhases];
  for (const p of discoveredPhases) if (!phases.includes(p)) phases.push(p);

  return {
    name,
    phases,
    calls,
    estimatedAgentCalls: calls.filter((c) => c.kind === "agent").length,
  };
}

const VARIANT_ICON: Record<ScriptNodeVariant, string> = {
  start: "▶",
  phase: "◆",
  agent: "🤖",
  parallel: "⇉",
  pipeline: "→",
  workflow: "⧉",
  end: "■",
};

/**
 * Convert a dynamic-script source into a read-only SvelteFlow graph: Start →
 * phase lanes (each phase header followed by its calls in order) → End. Calls
 * with no enclosing phase collect under an implicit "(no phase)" lane.
 */
export function scriptToGraph(
  script: string,
  meta?: unknown,
): { nodes: Node[]; edges: Edge[]; model: ScriptGraphModel } {
  const model = parseScriptStructure(script, meta);
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const X = 260;
  const XCALL = 300;
  const Y_STEP = 96;
  let y = 40;

  const push = (
    id: string,
    variant: ScriptNodeVariant,
    label: string,
    extra: Record<string, unknown> = {},
    x = X,
  ) => {
    nodes.push({
      id,
      type: SCRIPT_NODE_TYPE,
      position: { x, y },
      data: {
        label,
        variant,
        icon: VARIANT_ICON[variant],
        status: "idle",
        ...extra,
      },
      draggable: false,
      selectable: variant !== "start" && variant !== "end",
    });
    y += Y_STEP;
  };
  const link = (source: string, target: string, label?: string) => {
    edges.push({
      id: `${source}->${target}`,
      source,
      target,
      ...(label ? { label } : {}),
    });
  };

  push("__start__", "start", model.name || "Start");
  let prev = "__start__";

  // Group calls by phase in phase order; unphased calls go last under a lane.
  const laneOrder: string[] = [...model.phases];
  const unphased = model.calls.filter((c) => c.phase === null);
  const byPhase = new Map<string, ScriptGraphCall[]>();
  for (const p of laneOrder) byPhase.set(p, []);
  for (const c of model.calls) {
    if (c.phase === null) continue;
    if (!byPhase.has(c.phase)) {
      byPhase.set(c.phase, []);
      laneOrder.push(c.phase);
    }
    byPhase.get(c.phase)!.push(c);
  }

  const emitCall = (c: ScriptGraphCall) => {
    const id = `call-${c.order}`;
    const suffix = c.inLoop ? " ↻" : "";
    push(
      id,
      c.kind,
      c.label + suffix,
      { kind: c.kind, inLoop: c.inLoop, phase: c.phase },
      XCALL,
    );
    link(prev, id);
    prev = id;
  };

  for (const phase of laneOrder) {
    const phaseCalls = byPhase.get(phase) ?? [];
    const pid = `phase-${phase}`;
    push(pid, "phase", phase, { callCount: phaseCalls.length });
    link(prev, pid);
    prev = pid;
    for (const c of phaseCalls) emitCall(c);
  }
  if (unphased.length > 0) {
    const pid = "phase-__unphased__";
    push(pid, "phase", "(no phase)", { callCount: unphased.length });
    link(prev, pid);
    prev = pid;
    for (const c of unphased) emitCall(c);
  }

  push("__end__", "end", "End");
  link(prev, "__end__");

  return { nodes, edges, model };
}
