/**
 * Deterministic gate node (workspace/command, helper-pod pinned).
 *
 * Hardening vs the pre-generator inline gate:
 *  - pinned to the `${executionId}__cliws` helper pod (helperPod:true) so the
 *    heavy clone/install lands on the durable helper, not a fresh sandbox;
 *  - clone + overlay + build in POD-LOCAL /sandbox/scratch/gate-repo (NOT the
 *    JuiceFS /sandbox/work mount — build I/O off the shared FS);
 *  - pnpm bootstrap guard (corepack/npm -g fallback);
 *  - node_modules cached as a tarball on JuiceFS and restored per iteration;
 *  - every phase wrapped in `timeout N` and echoes `--- <phase> rc=<n>` + a
 *    tail of its log IMMEDIATELY, so a hung phase still leaves diagnostics;
 *  - writes a machine-readable /sandbox/work/gan/gate-<idx>.json the read_verdict
 *    step consumes, while still printing OBJECTIVE PASS/FAIL for humans.
 */
import type { GanFixtureConfig } from "../gan-config";
import { buildCommand } from "../jq";

function gateScript(cfg: GanFixtureConfig): string {
	const s = cfg.defaults.timeouts.gatePhaseSeconds;
	// NOTE: shell `${VAR}` is escaped as `\${VAR}` for the template literal;
	// `__TOKEN__` splice points are replaced with jq expressions by buildCommand.
	return `IDX=__IDX__
EXPORT_URL=__EXPORT_URL__
export CI=1
set +e
mkdir -p /sandbox/work/gan /sandbox/scratch
REPO=/sandbox/scratch/gate-repo
NM_CACHE=/sandbox/work/gan/gate-node-modules.tar
GATE_JSON=/sandbox/work/gan/gate-$IDX.json
# pnpm bootstrap for the NON-ROOT cli-agent user: the workspace pod has
# node/npm/corepack but no pnpm, and the user cannot write /usr/local/bin or the
# global npm prefix — so install into user-writable /tmp dirs and put them on
# PATH BEFORE any phase runs.
export PATH=/tmp/gan-bin:/tmp/gan-npm/bin:$PATH
if ! command -v pnpm >/dev/null 2>&1; then
  mkdir -p /tmp/gan-bin /tmp/gan-npm
  corepack enable --install-directory /tmp/gan-bin >/dev/null 2>&1 || npm i -g --prefix /tmp/gan-npm pnpm >/dev/null 2>&1
fi
rm -rf "$REPO"
if ! git clone --depth 1 --single-branch https://x-access-token:\${GITHUB_TOKEN}@github.com/${cfg.promote.repoUrl}.git "$REPO"; then
  echo "OBJECTIVE FAIL: clone failed"
  printf '{"pass":false,"phases":{"clone":1},"iteration":%s}' "$IDX" > "$GATE_JSON"
  exit 0
fi
if ! curl -sS "$EXPORT_URL" | tar -xz -C "$REPO"; then
  echo "OBJECTIVE FAIL: export overlay failed"
  printf '{"pass":false,"phases":{"overlay":1},"iteration":%s}' "$IDX" > "$GATE_JSON"
  exit 0
fi
cd "$REPO"
[ -f "$NM_CACHE" ] && tar -xf "$NM_CACHE" -C "$REPO" 2>/dev/null
IRC=0
if [ ! -d node_modules ]; then
  timeout ${s} pnpm install --no-frozen-lockfile >/tmp/gate-install.log 2>&1; IRC=$?
  echo "--- install rc=$IRC"; tail -25 /tmp/gate-install.log
  [ "$IRC" -eq 0 ] && tar -cf "$NM_CACHE" node_modules 2>/dev/null
else
  echo "--- install rc=0 (cached node_modules)"
fi
CRC=0; timeout ${s} pnpm check >/tmp/gate-check.log 2>&1; CRC=$?
echo "--- check rc=$CRC"; tail -25 /tmp/gate-check.log
BRC=0; timeout ${s} pnpm check:boundaries >/tmp/gate-bound.log 2>&1; BRC=$?
echo "--- boundaries rc=$BRC"; tail -25 /tmp/gate-bound.log
TRC=0; timeout ${s} pnpm test:unit >/tmp/gate-test.log 2>&1; TRC=$?
echo "--- test-unit rc=$TRC"; tail -25 /tmp/gate-test.log
export IRC CRC BRC TRC GATE_IDX=$IDX GATE_JSON
python3 - <<'PYZZ'
import json,os
phases={"install":int(os.environ.get("IRC","0") or 0),"check":int(os.environ.get("CRC","0") or 0),"boundaries":int(os.environ.get("BRC","0") or 0),"test-unit":int(os.environ.get("TRC","0") or 0)}
ok=all(v==0 for v in phases.values())
json.dump({"pass":ok,"phases":phases,"iteration":int(os.environ.get("GATE_IDX","0") or 0)},open(os.environ["GATE_JSON"],"w"))
PYZZ
if [ "$IRC" -eq 0 ] && [ "$CRC" -eq 0 ] && [ "$BRC" -eq 0 ] && [ "$TRC" -eq 0 ]; then
  echo "OBJECTIVE PASS: install+check+boundaries+test-unit OK"
else
  echo "OBJECTIVE FAIL: install rc=$IRC check rc=$CRC boundaries rc=$BRC test-unit rc=$TRC"
fi
`;
}

export function buildGateNode(cfg: GanFixtureConfig): Record<string, unknown> {
	const command = buildCommand(gateScript(cfg), {
		__IDX__: ".idx | tostring",
		__EXPORT_URL__: '(.enter_dev_mode.url // "") + "/__export"',
	});
	return {
		gate: {
			call: "workspace/command",
			with: {
				cliWorkspace: true,
				helperPod: true,
				helperTimeoutMinutes: cfg.defaults.timeouts.helperTimeoutMinutes,
				// cwd is applied BEFORE the script runs, so it must already exist on
				// iteration 0 — use the JuiceFS mount root, not /sandbox/work/gan (which
				// the script itself mkdir -p's). Scripts use absolute paths regardless.
				cwd: "/sandbox/work",
				command,
				timeoutMs: cfg.defaults.timeouts.gateTimeoutMs,
				allowFailure: true,
			},
		},
	};
}
