/**
 * Dynamic-script → canvas graph adapter.
 *
 * The dynamic-script engine's "spec" IS a JavaScript orchestration script
 * (the Claude Code Workflow dialect: `phase()`, `agent()`, `parallel()`,
 * `pipeline()`, `workflow()`), not an SW 1.0 node graph. This adapter derives a
 * READ-ONLY structural preview of that script for the SvelteFlow canvas so a
 * dynamic-script workflow shows its true SHAPE — including which steps fan out
 * in parallel and what each step consumes / produces (prompt in, schema out).
 *
 * It is a lightweight STATIC scan, not an execution — the true call graph only
 * exists at run time (the journal). So it groups calls by the `phase()` marker
 * they appear under, detects `parallel()` / `pipeline()` membership by paren
 * nesting, and resolves `ARR.map(() => agent())` fan-outs to their element
 * count + labels from the array literal. Dynamic loops/conditionals are
 * annotated (inLoop) rather than unrolled. The counterpart `specToGraph`
 * (spec-graph-adapter.ts) handles SW 1.0; this handles `engine: 'dynamic-script'`.
 */

import type { Node, Edge } from "@xyflow/svelte";

export type ScriptGraphCallKind =
  | "agent"
  | "parallel"
  | "pipeline"
  | "workflow"
  | "action"
  | "sleep"
  | "event"
  | "team";

/** SvelteFlow node type used for every dynamic-script node (one component). */
export const SCRIPT_NODE_TYPE = "script";

export type ScriptNodeVariant =
  | "start"
  | "phase"
  | "agent"
  | "parallel"
  | "pipeline"
  | "workflow"
  | "action"
  | "sleep"
  | "event"
  | "team"
  | "end";

/** Live-overlay aggregation for ONE source line (cutover P2b): journal rows
 * joined to static nodes by the evaluator-captured call_site.line. */
export interface CallLineState {
  total: number;
  running: number;
  done: number;
  error: number;
  skipped: number;
  runningSessionIds: string[];
  runningCallIds: string[];
}

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
  /** id of the innermost enclosing parallel()/pipeline() group, else null. */
  parentGroup: string | null;
  /** For a parallel()/pipeline() call: its own group id (members reference it). */
  groupId: string | null;
  /** For a group junction: a resolved `ARR.map()` fan-out (count + labels). */
  fanOut: { count: number; labels: string[] } | null;
  /** A one-line preview of the agent()'s prompt (its "input"), or null. */
  promptPreview: string | null;
  /** Does the agent() carry an `opts.schema` (typed/structured output)? */
  hasSchema: boolean;
  /** Top-level output-schema property names, if statically resolvable. */
  schemaProps: string[];
  /** 1-based source line of the call token (comment-stripping preserves
   * newlines, so this matches the STORED source — and the journal's
   * call_site.line join key from the evaluator's runtime capture). */
  line: number;
  /** id of the innermost enclosing while/for loop, else null (see model.loops). */
  loopId: string | null;
  /** action-kind: the '<service>/<action>' slug. */
  actionSlug: string | null;
  /** action-kind: the call tolerates failure (journals an error envelope). */
  allowFailure: boolean;
  /** sleep-kind: duration in seconds, when a numeric literal. */
  sleepSeconds: number | null;
  /** event-kind: gate name ('approval' for approve(), else the event name). */
  eventName: string | null;
  /** team-kind: which op (spawn|task|send|broadcast|status|join|shutdown). */
  teamOp: string | null;
  /** agent-kind: the named-agent slug/id from opts.agent (fail-closed dispatch). */
  agentRef: string | null;
  /** agent-kind: opts.model override, when a string literal. */
  model: string | null;
  /** agent-kind: bound to a workspace/sandbox (opts.sandbox or isolation:'shared'). */
  hasSandbox: boolean;
}

export interface ScriptGraphLoop {
  id: string;
  /** 'while' | 'for' */
  kind: string;
  /** 1-based source line of the loop keyword. */
  line: number;
}

export interface ScriptGraphModel {
  name: string;
  /** Declared (meta.phases) ∪ discovered phase() titles, in first-seen order. */
  phases: string[];
  calls: ScriptGraphCall[];
  /** while/for loops that contain at least one call (loop containers). */
  loops: ScriptGraphLoop[];
  /** Top-level meta.input property names (the run's expected arguments). */
  inputProps: string[];
  /** args.X → labels of the calls whose argument spans reference it (the
   * execute dialog captions each input with where it lands). */
  argUsage: Record<string, string[]>;
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

/** Blank the CONTENTS of every string/template literal (keeping quotes,
 * newlines, and exact length) so the structural token scan never matches
 * `agent(` / `parallel(` etc. that appear inside a prompt STRING. Positions are
 * preserved 1:1 with the comment-stripped source, so content readers still read
 * the real text at the same offsets. */
function maskStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  type Mode = "code" | "sq" | "dq" | "tpl";
  let mode: Mode = "code";
  while (i < n) {
    const c = src[i];
    if (mode === "code") {
      if (c === "'") mode = "sq";
      else if (c === '"') mode = "dq";
      else if (c === "`") mode = "tpl";
      out += c;
      i += 1;
      continue;
    }
    // string mode: keep escapes (2 chars) and newlines as-is length, blank rest
    if (c === "\\") {
      out += "  ";
      i += 2;
      continue;
    }
    if (
      (mode === "sq" && c === "'") ||
      (mode === "dq" && c === '"') ||
      (mode === "tpl" && c === "`")
    ) {
      mode = "code";
      out += c;
      i += 1;
      continue;
    }
    out += c === "\n" ? "\n" : " ";
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

/** Index of the paren that matches the `(` at `open`, or src.length. */
function matchParen(src: string, open: number): number {
  let d = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "(") d += 1;
    else if (src[i] === ")") {
      d -= 1;
      if (d === 0) return i;
    }
  }
  return src.length;
}

/** Index of the brace matching the `{` at `open`, or src.length. */
function matchBrace(src: string, open: number): number {
  let d = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") d += 1;
    else if (src[i] === "}") {
      d -= 1;
      if (d === 0) return i;
    }
  }
  return src.length;
}

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

/** A prompt preview: the first string/template arg's leading static text (up to
 * the first `${` interpolation), truncated. Reads a step's human "input". */
function promptPreview(src: string, open: number): string | null {
  let i = open + 1;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  const q = src[i];
  if (q !== "'" && q !== '"' && q !== "`") return null;
  let out = "";
  i += 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      out += c === "\\" && src[i + 1] === "n" ? " " : (src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (q === "`" && c === "$" && src[i + 1] === "{") break; // stop at interpolation
    if (c === q) break;
    out += c;
    i += 1;
  }
  const clean = out.replace(/\s+/g, " ").trim();
  return clean ? clean : null;
}

/** Read an `opts.label` string literal from the call's argument span.
 * `masked` bounds the span (structure); `real` supplies the label text. */
function labelFromOpts(masked: string, real: string, open: number): string | null {
  const end = matchParen(masked, open) + 1;
  const span = real.slice(open, end);
  const m = span.match(/label\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/);
  return m ? m[2] : null;
}

/** Split the top-level (depth-0) elements of an object/array body `{...}`/`[...]`
 * interior — used to count/label array elements and object keys. */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let i = 0;
  let atElementStart = true;
  const n = body.length;
  while (i < n) {
    const c = body[i];
    if (c === "{" || c === "[" || c === "(") depth += 1;
    else if (c === "}" || c === "]" || c === ")") depth -= 1;
    else if (c === "'" || c === '"' || c === "`") {
      // skip string
      const q = c;
      i += 1;
      while (i < n && body[i] !== q) {
        if (body[i] === "\\") i += 1;
        i += 1;
      }
    } else if (depth === 0) {
      if (atElementStart && /[A-Za-z_$'"]/.test(c)) {
        // read an identifier or quoted key up to `:` or `,`
        const m = body.slice(i).match(/^\s*(['"]?)([A-Za-z0-9_$]+)\1\s*:/);
        if (m) keys.push(m[2]);
        atElementStart = false;
      }
      if (c === ",") atElementStart = true;
    }
    i += 1;
  }
  return keys;
}

/** Count top-level elements in an array-literal interior `[ e0, e1, ... ]`. */
function topLevelElements(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let i = 0;
  const n = body.length;
  while (i < n) {
    const c = body[i];
    if (c === "{" || c === "[" || c === "(") depth += 1;
    else if (c === "}" || c === "]" || c === ")") depth -= 1;
    else if (c === "'" || c === '"' || c === "`") {
      const q = c;
      cur += c;
      i += 1;
      while (i < n && body[i] !== q) {
        if (body[i] === "\\") {
          cur += body[i] + (body[i + 1] ?? "");
          i += 2;
          continue;
        }
        cur += body[i];
        i += 1;
      }
      cur += body[i] ?? "";
      i += 1;
      continue;
    }
    if (depth === 0 && c === ",") {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** A short label for one array element (an object's `key`/`name`/`id`, or a
 * string literal, else null). */
function elementLabel(el: string): string | null {
  const key = el.match(/\b(?:key|name|id|slug|title)\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/);
  if (key) return key[2];
  const str = el.match(/^\s*(['"`])((?:\\.|(?!\1).)*)\1\s*$/);
  if (str) return str[2];
  return null;
}

/** Resolve a `parallel(IDENT.map(...))` fan-out from the array literal `IDENT`
 * declared in the source: its element count + best-effort per-element labels. */
function resolveFanOut(
  masked: string,
  real: string,
  open: number,
): { count: number; labels: string[] } | null {
  const close = matchParen(masked, open);
  const argHead = masked.slice(open + 1, Math.min(close, open + 200));
  const m = argHead.match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*map\s*\(/);
  if (!m) return null;
  const ident = m[1];
  // Find `const IDENT = [ ... ]` (or let/var).
  const declRe = new RegExp(
    `\\b(?:const|let|var)\\s+${ident}\\s*=\\s*\\[`,
  );
  const dm = declRe.exec(masked);
  if (!dm) return null;
  const bracketOpen = masked.indexOf("[", dm.index);
  if (bracketOpen < 0) return null;
  // match the closing bracket (on the masked source, so string-embedded
  // brackets never unbalance it)
  let d = 0;
  let end = bracketOpen;
  for (let i = bracketOpen; i < masked.length; i += 1) {
    if (masked[i] === "[") d += 1;
    else if (masked[i] === "]") {
      d -= 1;
      if (d === 0) {
        end = i;
        break;
      }
    }
  }
  // element labels come from the REAL source (key: 'perf' etc.)
  const body = real.slice(bracketOpen + 1, end);
  const els = topLevelElements(body);
  if (els.length === 0) return null;
  const labels = els.map((el, i) => elementLabel(el) ?? `#${i + 1}`);
  return { count: els.length, labels };
}

/** Extract structured-output info from an agent()'s argument span: whether it
 * carries `schema:` and, if resolvable, the top-level output property names. */
function extractSchema(
  src: string,
  open: number,
): { hasSchema: boolean; props: string[] } {
  const close = matchParen(src, open);
  const span = src.slice(open, close + 1);
  const sm = span.match(/\bschema\s*:\s*/);
  if (!sm) return { hasSchema: false, props: [] };
  const at = open + (sm.index ?? 0) + sm[0].length;
  // inline object schema: schema: { ... properties: { ... } }
  if (src[at] === "{") {
    const objEnd = matchBrace(src, at);
    const obj = src.slice(at, objEnd + 1);
    const pm = obj.match(/\bproperties\s*:\s*\{/);
    if (pm) {
      const pOpen = at + (pm.index ?? 0) + pm[0].length - 1;
      const pEnd = matchBrace(src, pOpen);
      return { hasSchema: true, props: topLevelKeys(src.slice(pOpen + 1, pEnd)) };
    }
    return { hasSchema: true, props: [] };
  }
  // named schema: schema: SOME_SCHEMA  → resolve its const definition
  const idm = src.slice(at).match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)/);
  if (idm) {
    const ident = idm[1];
    const declRe = new RegExp(`\\b(?:const|let|var)\\s+${ident}\\s*=\\s*\\{`);
    const dm = declRe.exec(src);
    if (dm) {
      const braceOpen = src.indexOf("{", dm.index);
      const braceEnd = matchBrace(src, braceOpen);
      const obj = src.slice(braceOpen, braceEnd + 1);
      const pm = obj.match(/\bproperties\s*:\s*\{/);
      if (pm) {
        const pOpen = braceOpen + (pm.index ?? 0) + pm[0].length - 1;
        const pEnd = matchBrace(src, pOpen);
        return { hasSchema: true, props: topLevelKeys(src.slice(pOpen + 1, pEnd)) };
      }
    }
    return { hasSchema: true, props: [] };
  }
  return { hasSchema: true, props: [] };
}

/** Read a string-literal opt (`key: 'value'`) from a call's argument span.
 * The KEY is matched on the masked source (string contents blanked, so prompt
 * text can't fake a key); the VALUE is read from the real source at the same
 * offset. */
function stringOptFromSpan(
  masked: string,
  real: string,
  open: number,
  key: string,
): string | null {
  const close = matchParen(masked, open);
  const span = masked.slice(open, close + 1);
  const km = new RegExp(`\\b${key}\\s*:\\s*(['"\`])`).exec(span);
  if (!km) return null;
  const qAt = open + (km.index ?? 0) + km[0].length - 1;
  const q = real[qAt];
  let i = qAt + 1;
  let out = "";
  while (i < real.length && real[i] !== q) {
    if (real[i] === "\\") {
      out += real[i + 1] ?? "";
      i += 2;
      continue;
    }
    out += real[i];
    i += 1;
  }
  return out || null;
}

/** True when `key: true` (or a bare `key,`/`key }` shorthand) appears in the
 * call's argument span (masked, so prompts can't fake it). */
function boolOptFromSpan(masked: string, open: number, key: string): boolean {
  const close = matchParen(masked, open);
  const span = masked.slice(open, close + 1);
  return new RegExp(`\\b${key}\\s*:\\s*true\\b`).test(span);
}

/** True when the span mentions the key at all (e.g. `sandbox: {...}`). */
function hasOptKey(masked: string, open: number, key: string): boolean {
  const close = matchParen(masked, open);
  const span = masked.slice(open, close + 1);
  return new RegExp(`\\b${key}\\s*:`).test(span);
}

function truncate(s: string, max = 48): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

/**
 * Parse a dynamic-script source into its structural model (phases + calls with
 * group/fan-out/schema metadata). Pure + deterministic (no execution).
 */
export function parseScriptStructure(
  script: string,
  meta?: unknown,
): ScriptGraphModel {
  const src = stripComments(String(script ?? ""));
  // Structural scans run on `masked` (string contents blanked) so tokens/parens
  // inside prompt strings are ignored; content readers use `src` at the same
  // offsets (maskStrings preserves length 1:1).
  const masked = maskStrings(src);
  const declaredPhases = PHASE_TITLES_FROM_META(meta);
  const name =
    (meta as { name?: unknown } | null | undefined)?.name &&
    typeof (meta as { name: unknown }).name === "string"
      ? (meta as { name: string }).name
      : "dynamic-script";

  // Precompute loop spans (while/for bodies): each becomes an IDENTIFIED loop
  // so the canvas can draw a repeat container + loop-back edge, not just a chip.
  const loopSpans: Array<{ id: string; kind: string; start: number; end: number; kwIndex: number }> = [];
  const loopKw = /\b(while|for)\s*\(/g;
  let lm: RegExpExecArray | null;
  while ((lm = loopKw.exec(masked))) {
    let i = lm.index + lm[0].length;
    let d = 1;
    for (; i < masked.length && d > 0; i += 1) {
      if (masked[i] === "(") d += 1;
      else if (masked[i] === ")") d -= 1;
    }
    while (i < masked.length && /\s/.test(masked[i])) i += 1;
    if (masked[i] !== "{") continue;
    let bd = 1;
    const bodyStart = i;
    i += 1;
    for (; i < masked.length && bd > 0; i += 1) {
      if (masked[i] === "{") bd += 1;
      else if (masked[i] === "}") bd -= 1;
    }
    loopSpans.push({
      id: `loop${loopSpans.length}`,
      kind: lm[1],
      start: bodyStart,
      end: i,
      kwIndex: lm.index,
    });
  }
  // Innermost enclosing loop wins (spans nest; the tightest span is the label).
  const loopAt = (pos: number): string | null => {
    let best: { id: string; size: number } | null = null;
    for (const sp of loopSpans) {
      if (pos >= sp.start && pos < sp.end) {
        const size = sp.end - sp.start;
        if (!best || size < best.size) best = { id: sp.id, size };
      }
    }
    return best?.id ?? null;
  };
  const inLoopAt = (pos: number) => loopAt(pos) !== null;

  // Ordered line cursor: the token scan advances monotonically, so counting
  // newlines incrementally is O(n) total.
  let lineCursorIdx = 0;
  let lineCursorLine = 1;
  const lineOf = (idx: number): number => {
    for (; lineCursorIdx < idx; lineCursorIdx += 1) {
      if (masked.charCodeAt(lineCursorIdx) === 10) lineCursorLine += 1;
    }
    return lineCursorLine;
  };

  // Single ordered scan for the FULL dialect: control constructs, agent calls,
  // durable actions/sleeps/gates, and team ops.
  const tokenRe =
    /\b(phase|agent|parallel|pipeline|workflow|action|sleep|approve|waitForEvent)\s*\(|\bteam\s*\.\s*(spawn|task|send|broadcast|status|join|shutdown)\s*\(/g;
  const discoveredPhases: string[] = [];
  const calls: ScriptGraphCall[] = [];
  const argUsage: Record<string, string[]> = {};
  let currentPhase: string | null = null;
  let order = 0;
  let tm: RegExpExecArray | null;
  // Stack of open parallel/pipeline groups: a call's innermost enclosing group.
  const groupStack: Array<{ id: string; close: number }> = [];

  while ((tm = tokenRe.exec(masked))) {
    const token = tm[1] ?? "team";
    const teamOpToken = tm[2] ?? null;
    const open = tm.index + tm[0].length - 1; // index of "("

    // Pop groups we've scanned past.
    while (groupStack.length && groupStack[groupStack.length - 1].close <= tm.index) {
      groupStack.pop();
    }

    if (token === "phase") {
      const title = firstStringArg(src, open);
      if (title) {
        currentPhase = title;
        if (!discoveredPhases.includes(title)) discoveredPhases.push(title);
      }
      continue;
    }

    const kind: ScriptGraphCallKind =
      token === "approve" || token === "waitForEvent"
        ? "event"
        : token === "team"
          ? "team"
          : (token as ScriptGraphCallKind);

    const parentGroup = groupStack.length
      ? groupStack[groupStack.length - 1].id
      : null;

    let label: string;
    let promptText: string | null = null;
    let schema = { hasSchema: false, props: [] as string[] };
    let fanOut: { count: number; labels: string[] } | null = null;
    let groupId: string | null = null;
    let actionSlug: string | null = null;
    let allowFailure = false;
    let sleepSeconds: number | null = null;
    let eventName: string | null = null;
    let teamOp: string | null = null;
    let agentRef: string | null = null;
    let model: string | null = null;
    let hasSandbox = false;

    if (kind === "workflow") {
      const wfName = firstStringArg(src, open);
      label = wfName ? wfName : "workflow()";
    } else if (kind === "parallel" || kind === "pipeline") {
      groupId = `g${order}`;
      fanOut = resolveFanOut(masked, src, open);
      label = kind === "parallel" ? "parallel" : "pipeline";
      groupStack.push({ id: groupId, close: matchParen(masked, open) });
    } else if (kind === "action") {
      actionSlug = firstStringArg(src, open);
      allowFailure = boolOptFromSpan(masked, open, "allowFailure");
      const optLabel = labelFromOpts(masked, src, open);
      label = optLabel ?? actionSlug ?? "action()";
    } else if (kind === "sleep") {
      const close = matchParen(masked, open);
      const nm = src.slice(open + 1, close).match(/^\s*(\d+(?:\.\d+)?)/);
      sleepSeconds = nm ? Number(nm[1]) : null;
      label = sleepSeconds != null ? `wait ${sleepSeconds}s` : "sleep()";
    } else if (kind === "event") {
      if (token === "approve") {
        eventName = "approval";
        const msg = stringOptFromSpan(masked, src, open, "message");
        label = msg ? truncate(msg, 40) : "approval gate";
      } else {
        eventName = firstStringArg(src, open);
        label = eventName ?? "waitForEvent()";
      }
    } else if (kind === "team") {
      teamOp = teamOpToken;
      const optLabel = labelFromOpts(masked, src, open);
      label = optLabel ?? `team.${teamOpToken ?? "op"}`;
      if (teamOpToken === "task" || teamOpToken === "broadcast") {
        promptText = promptPreview(src, open);
      }
    } else {
      // agent()
      const optLabel = labelFromOpts(masked, src, open);
      promptText = promptPreview(src, open);
      if (optLabel) label = optLabel;
      else label = promptText ? truncate(promptText) : "agent()";
      schema = extractSchema(masked, open);
      agentRef = stringOptFromSpan(masked, src, open, "agent");
      model = stringOptFromSpan(masked, src, open, "model");
      hasSandbox =
        hasOptKey(masked, open, "sandbox") ||
        stringOptFromSpan(masked, src, open, "isolation") === "shared";
    }

    {
      // args.X references inside THIS call's argument span. Scanned on the
      // REAL source (not masked) so template interpolations — the common way
      // prompts consume args — are counted; captions are advisory, so a prose
      // mention costing a stray caption is the right tradeoff.
      const close = matchParen(masked, open);
      const span = src.slice(open, close + 1);
      let am: RegExpExecArray | null;
      const argRe = /\bargs\s*[.?]\.?\s*([A-Za-z_$][\w$]*)/g;
      while ((am = argRe.exec(span))) {
        const arr = (argUsage[am[1]] ??= []);
        if (!arr.includes(label)) arr.push(label);
      }
    }
    calls.push({
      kind,
      label,
      phase: currentPhase,
      inLoop: inLoopAt(open),
      order: order++,
      parentGroup,
      groupId,
      fanOut,
      promptPreview: promptText,
      hasSchema: schema.hasSchema,
      schemaProps: schema.props,
      line: lineOf(tm.index),
      loopId: loopAt(open),
      actionSlug,
      allowFailure,
      sleepSeconds,
      eventName,
      teamOp,
      agentRef,
      model,
      hasSandbox,
    });
  }

  const phases: string[] = [...declaredPhases];
  for (const p of discoveredPhases) if (!phases.includes(p)) phases.push(p);

  // Only loops that actually contain a call become containers.
  const lineAt = (idx: number): number => {
    let line = 1;
    for (let i = 0; i < idx && i < masked.length; i += 1) {
      if (masked.charCodeAt(i) === 10) line += 1;
    }
    return line;
  };
  const loops: ScriptGraphLoop[] = loopSpans
    .filter((sp) => calls.some((c) => c.loopId === sp.id))
    .map((sp) => ({ id: sp.id, kind: sp.kind, line: lineAt(sp.kwIndex) }));

  // meta.input top-level property names (the run's expected arguments).
  const metaInput = (meta as { input?: { properties?: Record<string, unknown> } } | null)
    ?.input;
  const inputProps =
    metaInput && typeof metaInput === "object" && metaInput.properties &&
    typeof metaInput.properties === "object"
      ? Object.keys(metaInput.properties)
      : [];

  return {
    name,
    phases,
    calls,
    loops,
    inputProps,
    argUsage,
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
  action: "⚡",
  sleep: "◔",
  event: "✋",
  team: "⚇",
  end: "■",
};

// Layout geometry — a layered top-to-bottom flow. Every CALL node is a uniform
// NODE_W-wide card; parallel members spread across centered columns. Vertical
// rhythm is CONTENT-AWARE: each node advances by its estimated height + gap,
// so dense cards get room and capsules (sleep, junctions) sit tight.
const NODE_W = 264;
const COL_GAP = 296;
const CENTER = 560;
const ROW_GAP = 46;

/** Estimated rendered height per call card (matches script-node's rows). */
function estimateCallHeight(c: ScriptGraphCall | null): number {
  if (!c) return 96;
  if (c.kind === "sleep") return 34; // capsule
  if (c.kind === "parallel" || c.kind === "pipeline") return 32; // junction chip
  let h = 62; // header + title
  if (c.promptPreview) h += 20;
  if (c.hasSchema) h += 22;
  if (c.actionSlug && c.actionSlug !== c.label) h += 18;
  if (c.eventName) h += 18;
  if (c.agentRef || c.model || c.hasSandbox) h += 22;
  return h;
}

/**
 * Convert a dynamic-script source into a read-only SvelteFlow graph: Start →
 * phase headers → their calls (sequential stacked, or parallel/pipeline members
 * fanned across columns) → End. Parallel groups fan out from a junction and back
 * in; `ARR.map()` fan-outs render one column per resolved element.
 */
export function scriptToGraph(
  script: string,
  meta?: unknown,
): { nodes: Node[]; edges: Edge[]; model: ScriptGraphModel } {
  const model = parseScriptStructure(script, meta);
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const pushNode = (
    id: string,
    variant: ScriptNodeVariant,
    label: string,
    y: number,
    centerX: number,
    extra: Record<string, unknown> = {},
  ) => {
    nodes.push({
      id,
      type: SCRIPT_NODE_TYPE,
      position: { x: Math.round(centerX - NODE_W / 2), y },
      data: {
        label,
        variant,
        icon: VARIANT_ICON[variant],
        status: "idle",
        width: NODE_W,
        ...extra,
      },
      draggable: false,
      selectable: variant !== "start" && variant !== "end",
    });
  };
  const link = (
    source: string,
    target: string,
    opts: { parallel?: boolean; label?: string } = {},
  ) => {
    edges.push({
      id: `${source}->${target}`,
      source,
      target,
      data: { parallel: Boolean(opts.parallel) },
      ...(opts.label ? { label: opts.label } : {}),
    });
  };

  let y = 24;
  pushNode("__start__", "start", model.name || "Start", y, CENTER, {
    inputProps: model.inputProps,
  });
  let prev: string[] = ["__start__"];
  y += (model.inputProps.length > 0 ? 64 : 36) + ROW_GAP;

  // Group calls by phase (declared order first); unphased collect under a lane.
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

  const columnsFor = (junction: ScriptGraphCall, members: ScriptGraphCall[]) => {
    // Explicit thunk members win; else an ARR.map() fan-out clones the single
    // template across the resolved element labels (capped for sanity).
    if (members.length > 1) {
      return members.map((m) => ({
        id: `call-${m.order}`,
        label: m.label,
        call: m,
      }));
    }
    if (junction.fanOut && junction.fanOut.count > 1) {
      const cap = Math.min(junction.fanOut.count, 8);
      const template = members[0] ?? null;
      return Array.from({ length: cap }, (_, i) => ({
        id: `call-${junction.order}-fan-${i}`,
        label: junction.fanOut!.labels[i] ?? `#${i + 1}`,
        call: template,
      }));
    }
    return members.map((m) => ({ id: `call-${m.order}`, label: m.label, call: m }));
  };

  const emitCallData = (c: ScriptGraphCall | null, labelOverride?: string) => ({
    kind: c?.kind ?? "agent",
    line: c?.line ?? null,
    inLoop: c?.inLoop ?? false,
    loopId: c?.loopId ?? null,
    phase: c?.phase ?? null,
    promptPreview: c?.promptPreview ?? null,
    hasSchema: c?.hasSchema ?? false,
    schemaProps: c?.schemaProps ?? [],
    actionSlug: c?.actionSlug ?? null,
    allowFailure: c?.allowFailure ?? false,
    sleepSeconds: c?.sleepSeconds ?? null,
    eventName: c?.eventName ?? null,
    teamOp: c?.teamOp ?? null,
    agentRef: c?.agentRef ?? null,
    model: c?.model ?? null,
    hasSandbox: c?.hasSandbox ?? false,
    ...(labelOverride ? { memberLabel: labelOverride } : {}),
  });

  const loopMembers = new Map<string, string[]>();
  const trackLoop = (c: ScriptGraphCall | null, nodeId: string) => {
    if (!c?.loopId) return;
    const arr = loopMembers.get(c.loopId) ?? [];
    arr.push(nodeId);
    loopMembers.set(c.loopId, arr);
  };

  const emitPhaseCalls = (phaseCalls: ScriptGraphCall[]) => {
    // Walk calls in order; a parallel/pipeline junction consumes its members.
    const consumed = new Set<number>();
    for (const c of phaseCalls) {
      if (consumed.has(c.order)) continue;

      if (c.kind === "parallel" || c.kind === "pipeline") {
        const members = phaseCalls.filter((m) => m.parentGroup === c.groupId);
        members.forEach((m) => consumed.add(m.order));
        const cols = columnsFor(c, members);
        const fanCount = cols.length || c.fanOut?.count || 0;

        // Junction node (compact branch point).
        const jid = `call-${c.order}`;
        pushNode(jid, c.kind, c.label, y, CENTER, {
          kind: c.kind,
          line: c.line,
          fanCount,
          fanOut: Boolean(c.fanOut),
          inLoop: c.inLoop,
        });
        trackLoop(c, jid);
        for (const p of prev) link(p, jid);
        y += 32 + ROW_GAP;

        // Member columns (fan out from the junction).
        const m = Math.max(1, cols.length);
        const total = (m - 1) * COL_GAP;
        const isPipeline = c.kind === "pipeline";
        const colIds: string[] = [];
        cols.forEach((col, i) => {
          const cx = CENTER - total / 2 + i * COL_GAP;
          const variant: ScriptNodeVariant = col.call?.kind ?? "agent";
          pushNode(col.id, variant, col.label, y, cx, {
            ...emitCallData(col.call, col.label),
            label: col.label,
            column: i,
          });
          if (col.call && col.id === `call-${col.call.order}`) trackLoop(col.call, col.id);
          colIds.push(col.id);
          if (isPipeline && i > 0) {
            link(colIds[i - 1], col.id, { label: "then" });
          } else {
            link(jid, col.id, { parallel: !isPipeline });
          }
        });
        // Fan-in: the next node depends on all leaf columns (parallel) or the
        // last stage (pipeline).
        prev = isPipeline && colIds.length ? [colIds[colIds.length - 1]] : colIds;
        const tallest = Math.max(96, ...cols.map((col) => estimateCallHeight(col.call)));
        y += tallest + ROW_GAP;
        continue;
      }

      // Plain sequential call.
      if (c.parentGroup) continue; // safety: members handled above
      const id = `call-${c.order}`;
      pushNode(id, c.kind, c.label, y, CENTER, emitCallData(c));
      trackLoop(c, id);
      for (const p of prev) link(p, id);
      prev = [id];
      y += estimateCallHeight(c) + ROW_GAP;
    }
  };

  for (const phase of laneOrder) {
    const phaseCalls = byPhase.get(phase) ?? [];
    const pid = `phase-${phase}`;
    pushNode(pid, "phase", phase, y, CENTER, { callCount: phaseCalls.length });
    for (const p of prev) link(p, pid);
    prev = [pid];
    y += 52 + ROW_GAP;
    emitPhaseCalls(phaseCalls);
  }
  if (unphased.length > 0) {
    const pid = "phase-__unphased__";
    pushNode(pid, "phase", "(no phase)", y, CENTER, { callCount: unphased.length });
    for (const p of prev) link(p, pid);
    prev = [pid];
    y += 52 + ROW_GAP;
    emitPhaseCalls(unphased);
  }

  pushNode("__end__", "end", "End", y, CENTER);
  for (const p of prev) link(p, "__end__");

  // Loop-back edges: last member → first member, one per loop container, so a
  // refine/critic loop reads as a cycle instead of a straight line.
  for (const loop of model.loops) {
    const members = loopMembers.get(loop.id) ?? [];
    if (members.length < 2) continue;
    edges.push({
      id: `loop-${loop.id}`,
      source: members[members.length - 1],
      target: members[0],
      data: { loop: true },
      label: "repeats",
    });
  }

  return { nodes, edges, model };
}
