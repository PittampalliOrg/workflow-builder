/**
 * Legacy SW 1.0 spec → ScriptGraphModel translator (canvas unification).
 *
 * The cutover renders EVERY workflow through the one code-first canvas.
 * Dynamic-script rows parse their source (script-graph-adapter); legacy SW
 * rows translate their `do[]` spec into the SAME model here — read-only, no
 * source lines (line 0 disables the code⇄canvas join) — so old workflows get
 * the new visual system instead of the retired node editor.
 *
 * Mapping (the shapes the platform actually authored):
 *   durable/run            → agent   (prompt preview, agentRef slug/id)
 *   <service>/<action>     → action  (slug chip; allowFailure from `with`)
 *   listen                 → event   (approval-style gate)
 *   wait                   → sleep
 *   for/while wrappers     → loop containers over their nested do[]
 *   set-only steps         → skipped (projection steps, not calls)
 */
import type {
  ScriptGraphCall,
  ScriptGraphCallKind,
  ScriptGraphLoop,
  ScriptGraphModel,
} from "./script-graph-adapter";

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Strip a jq template down to a short preview ("${ .a // \"x\" }" → "…"). */
function preview(v: unknown, max = 64): string | null {
  const text = str(v);
  if (!text) return null;
  const clean = text
    .replace(/\$\{[\s\S]*?\}/g, "…")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || clean === "…") return null;
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function emptyCall(kind: ScriptGraphCallKind, label: string, order: number): ScriptGraphCall {
  return {
    kind,
    label,
    phase: null,
    inLoop: false,
    order,
    parentGroup: null,
    groupId: null,
    fanOut: null,
    promptPreview: null,
    hasSchema: false,
    schemaProps: [],
    line: 0,
    loopId: null,
    actionSlug: null,
    allowFailure: false,
    sleepSeconds: null,
    eventName: null,
    teamOp: null,
    agentRef: null,
    model: null,
    hasSandbox: false,
  };
}

export function swSpecToScriptModel(spec: unknown): ScriptGraphModel {
  const root = isRec(spec) ? spec : {};
  const doc = isRec(root.document) ? root.document : {};
  const name = str(doc.name) ?? str(root.name) ?? "workflow";
  const calls: ScriptGraphCall[] = [];
  const loops: ScriptGraphLoop[] = [];
  let order = 0;

  const walk = (steps: unknown, loopId: string | null) => {
    if (!Array.isArray(steps)) return;
    for (const entry of steps) {
      if (!isRec(entry)) continue;
      const [stepName] = Object.keys(entry);
      if (!stepName) continue;
      const task = entry[stepName];
      if (!isRec(task)) continue;

      // for/while wrapper → a loop container over the nested do[].
      if ((task.for || task.while) && Array.isArray(task.do)) {
        const id = `loop${loops.length}`;
        loops.push({ id, kind: task.while ? "while" : "for", line: 0 });
        walk(task.do, id);
        continue;
      }

      // listen gate.
      if (isRec(task.listen)) {
        const call = emptyCall("event", stepName, order++);
        call.eventName = "approval";
        call.loopId = loopId;
        call.inLoop = loopId !== null;
        calls.push(call);
        continue;
      }

      const callSlug = str(task.call);
      const w = isRec(task.with) ? task.with : {};

      if (callSlug === "durable/run") {
        const call = emptyCall("agent", stepName, order++);
        const body = isRec(w.body) ? w.body : {};
        call.promptPreview = preview(body.prompt);
        const agentRef = isRec(w.agentRef)
          ? w.agentRef
          : isRec(body.agentRef)
            ? body.agentRef
            : null;
        call.agentRef = agentRef ? (str(agentRef.slug) ?? preview(agentRef.id, 24)) : null;
        call.hasSandbox = Boolean(w.workspaceRef ?? w.sandboxName);
        call.loopId = loopId;
        call.inLoop = loopId !== null;
        calls.push(call);
        continue;
      }

      if (callSlug === "wait") {
        const call = emptyCall("sleep", stepName, order++);
        call.loopId = loopId;
        call.inLoop = loopId !== null;
        calls.push(call);
        continue;
      }

      if (callSlug && callSlug.includes("/")) {
        const call = emptyCall("action", stepName, order++);
        call.actionSlug = callSlug;
        call.allowFailure = w.allowFailure === true;
        call.loopId = loopId;
        call.inLoop = loopId !== null;
        calls.push(call);
        continue;
      }

      // `set`-only steps are output projections, not calls — skip quietly.
    }
  };

  walk(root.do, null);

  return {
    name,
    phases: [],
    calls,
    loops: loops.filter((l) => calls.some((c) => c.loopId === l.id)),
    inputProps: [],
    estimatedAgentCalls: calls.filter((c) => c.kind === "agent").length,
  };
}
