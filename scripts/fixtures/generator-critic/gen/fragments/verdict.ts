/**
 * Verdict conventions — the canonical, FILE-FIRST loop-exit signal.
 *
 * The critic writes /sandbox/work/gan/verdict-<idx>.json (schema gan.verdict/v1)
 * BEFORE its final message; its final message repeats the same strict JSON as a
 * fallback. `read_verdict` (helper-pod pinned) reads the file when present+valid
 * (an `iteration` field must equal <idx>); otherwise it falls back to the
 * env-injected SCORE/MEETS parsed from the critique message, recording
 * `verdict_source: "file" | "message" | "missing"`. It then computes THE single
 * source of truth (accepted / stalled / best / terminal) and prints one compact
 * JSON that the while-condition, promote and summary all read — nothing
 * downstream re-derives acceptance from the raw critique message.
 */
import type { GanFixtureConfig } from "../gan-config";
import { buildCommand } from "../jq";

/** Verdict schema id the critic stamps into the file. */
export const VERDICT_SCHEMA = "gan.verdict/v1";

/**
 * Instruction appended to the critic (persona + prompt) so it writes the file
 * verdict before its final message. `idxExpr` is a jq snippet yielding the
 * current iteration index (or a literal for the persona copy).
 */
export function verdictFileInstruction(idxLabel: string): string {
	return (
		`FIRST write the exact same JSON verdict object (plus \\"iteration\\": ${idxLabel} and ` +
		`\\"schema\\": \\"${VERDICT_SCHEMA}\\") to /sandbox/work/gan/verdict-${idxLabel}.json ` +
		`(mkdir -p /sandbox/work/gan), THEN emit the identical JSON as your final message ` +
		`(same strict shape — the file is the primary signal, the message is the fallback).`
	);
}

function readVerdictScript(): string {
	// Shell header exports the message-fallback signal + gate result, then a
	// single python pass does file-first read, stall/best math, progress append.
	return `IDX=__IDX__
export ACCEPT_SCORE=__ACCEPT_SCORE__
export STALL_WINDOW=__STALL_WINDOW__
export SCORE=__SCORE__
export MEETS=__MEETS__
export CRIT_PRESENT=__CRIT_PRESENT__
export FEEDBACK=__FEEDBACK_SH__
export ENVISSUES=__ENVISSUES_SH__
mkdir -p /sandbox/work/gan
GATE_JSON=/sandbox/work/gan/gate-$IDX.json
export GATE_PASS=$(python3 -c 'import json,sys
try:
    print("true" if json.load(open(sys.argv[1])).get("pass") else "false")
except Exception:
    print("false")' "$GATE_JSON" 2>/dev/null || echo false)
export VERDICT_FILE=/sandbox/work/gan/verdict-$IDX.json
export GAN_IDX=$IDX
python3 - <<'PYZZ'
import json,os
idx=int(os.environ.get("GAN_IDX","0") or 0)
try: accept_score=float(os.environ.get("ACCEPT_SCORE","8") or 8)
except Exception: accept_score=8.0
try: K=int(float(os.environ.get("STALL_WINDOW","2") or 2))
except Exception: K=2
if K<1: K=1
gate_pass=(os.environ.get("GATE_PASS","false")=="true")
# ---- FILE FIRST: verdict-<idx>.json with a matching iteration wins ----
source="missing"; meets=False; score=0.0; feedback=""; env_issues=[]
data=None
try:
    with open(os.environ.get("VERDICT_FILE","")) as fh: data=json.load(fh)
except Exception: data=None
if isinstance(data,dict) and str(data.get("iteration"))==str(idx):
    source="file"
    meets=bool(data.get("meets_criteria"))
    try: score=float(data.get("score") or 0)
    except Exception: score=0.0
    feedback=str(data.get("feedback") or "")
    ei=data.get("envIssues")
    if isinstance(ei,list): env_issues=ei
elif os.environ.get("CRIT_PRESENT","false")=="true":
    # ---- fall back to the env-injected message-parsed verdict ----
    source="message"
    meets=(os.environ.get("MEETS","false")=="true")
    try: score=float(os.environ.get("SCORE","0") or 0)
    except Exception: score=0.0
    feedback=os.environ.get("FEEDBACK","") or ""
    try:
        ei=json.loads(os.environ.get("ENVISSUES","[]") or "[]")
        if isinstance(ei,list): env_issues=ei
    except Exception: env_issues=[]
if score>10: score=score/10.0
# ---- progress log (append this iteration) ----
P="/sandbox/work/gan/progress.json"
try: prog=json.load(open(P))
except Exception: prog={"log":[]}
if not isinstance(prog,dict) or not isinstance(prog.get("log"),list): prog={"log":[]}
accepted=bool(meets and score>=accept_score and gate_pass)
prog["log"].append({"iteration":idx,"score":score,"meets":meets,"gate_pass":gate_pass,"accepted":accepted,"source":source})
# stall series EXCLUDES missing-source iterations (a skipped/absent verdict is not progress)
series=[(e.get("iteration"),float(e.get("score") or 0)) for e in prog["log"] if e.get("source")!="missing"]
scores=[s for (_,s) in series]
stalled=False
if (not accepted) and len(scores)>=K+1:
    stalled=(max(scores[-K:])<=max(scores[:-K]))
if series:
    best_i,best_score=max(series,key=lambda t:t[1])
else:
    best_i,best_score=idx,score
terminal=("satisfied" if accepted else ("stalled" if stalled else None))
json.dump(prog,open(P,"w"))
print(json.dumps({"schema":"gan.verdict/v1","iteration":idx,"verdict_source":source,"meets_criteria":meets,"score":score,"gate_pass":gate_pass,"accepted":accepted,"stalled":stalled,"best_score":best_score,"best_iteration":best_i,"terminal":terminal,"iterations":len(prog["log"]),"feedback":feedback,"envIssues":env_issues},separators=(",",":")))
PYZZ
`;
}

export function buildReadVerdictNode(cfg: GanFixtureConfig): Record<string, unknown> {
	const command = buildCommand(readVerdictScript(), {
		__IDX__: ".idx | tostring",
		__ACCEPT_SCORE__: `(.trigger.acceptScore // ${cfg.defaults.acceptScore}) | tostring`,
		__STALL_WINDOW__: `(.trigger.stallWindow // ${cfg.defaults.stallWindow}) | tostring`,
		__SCORE__: "(.loop.last.critique.score // 0) | tostring",
		__MEETS__: "(.loop.last.critique.meets_criteria // false) | tostring",
		__CRIT_PRESENT__:
			'(((.loop.last.critique) != null) and (((.loop.last.critique) | type) == "object")) | tostring',
		__FEEDBACK_SH__: '(.loop.last.critique.feedback // "") | @sh',
		__ENVISSUES_SH__: "(.loop.last.critique.envIssues // []) | tojson | @sh",
	});
	return {
		read_verdict: {
			call: "workspace/command",
			with: {
				cliWorkspace: true,
				helperPod: true,
				helperTimeoutMinutes: cfg.defaults.timeouts.helperTimeoutMinutes,
				// cwd is applied BEFORE the script runs — must exist on iteration 0.
				// Use the JuiceFS mount root; the script mkdir -p's /sandbox/work/gan.
				cwd: "/sandbox/work",
				command,
				timeoutMs: 60000,
				allowFailure: true,
			},
		},
	};
}
