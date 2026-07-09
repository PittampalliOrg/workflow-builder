export const meta = {
  name: 'capability-pillar1-mcpserver-eval-and-plan',
  description: 'Evaluate Dapr MCPServer CRD + dapr-agents 1.0.4 auto-discovery for dapr-agent-py, and produce the Pillar-1 capability-compiler implementation plan',
  phases: [
    { title: 'Investigate', detail: 'MCPServer/dapr-agents path + map the translators to collapse + skills-gap (parallel)' },
    { title: 'Synthesize', detail: 'decision + actionable Pillar-1 implementation plan, adversarially checked' },
  ],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'

const CONTEXT = `
Project: workflow-builder at ${REPO}. We are starting Pillar 1 of the "capability standardization" plan:
CONSOLIDATE the duplicated agent-capability translation (MCP servers + skills) into ONE shared
"capability compiler" with per-target emitters, and CLOSE capability gaps. Targets/runtimes:
claude-agent-py (Claude Agent SDK), claude-code-cli, codex-cli, agy-cli (all cli-agent-py adapters),
and dapr-agent-py (the in-cluster DurableAgent runtime, built on the dapr-agents framework).

JUST-COMPLETED CONTEXT (verified this session): the platform is now on **Dapr 1.18** (control plane +
SDK on both ryzen + dev). dapr-agent-py now uses **dapr-agents==1.0.4** (the latest; bumped in the 1.18
app-SDK upgrade). dapr-agents v1.0.4 ADDED "MCPServer auto-discovery via the Dapr metadata API +
workflow orchestration". Dapr 1.18 ADDED an **MCPServer CRD** (daprd registers
dapr.internal.mcp.<server>.{ListTools,CallTool} workflows). These two together MIGHT let dapr-agent-py
get MCP servers natively from Dapr instead of our per-runtime translation.

CURRENT MCP/skill translation that Pillar 1 will consolidate (the duplication to collapse):
- build_mcp_servers exists in 3 near-identical copies: services/{dapr-agent-py,claude-agent-py,cli-agent-py}/src/mcp_config.py
  (NOTE: post-1.18, cli/claude lost durabletask-dapr; unrelated. mcp_config.py is the MCP translator.)
- services/dapr-agent-py/src/main.py has _extract_mcp_server_configs (the dapr-agent-py per-turn MCP config; emits {transport:...}).
- The 3 cli-agent-py adapters (services/cli-agent-py/src/cli_adapters/{claude_code,codex,antigravity}.py) each
  re-emit mcpServers into native form in seed(): claude→.mcp.json (--mcp-config), codex→config.toml [mcp_servers.<name>],
  agy→~/.gemini/config/mcp_config.json (key 'serverUrl'). SKILLS are materialized ONLY by claude_code.py;
  codex.py + antigravity.py DROP skills (the gap to close).
- MCP RESOLUTION (project connections + credential reference-forwarding via X-Connection-External-Id, the
  encrypted app_connections decrypt) lives in the BFF (src/lib/server/agents/mcp-resolution.ts +
  resolveAgentConfigMcpForProject) + the orchestrator (services/workflow-orchestrator/activities/resolve_mcp_config.py).
  This stays put — the compiler is the FINAL native-emit step AFTER resolution.
- dapr-agent-py reads DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON (env, from registry-sync.ts) + a per-turn
  mcpServers from session_workflow input. Our MCP servers are mostly in-cluster ap-<piece>-service /mcp endpoints
  (per-piece Knative) + custom URLs + the goal MCP server, each bound to an encrypted app_connection credential.

The earlier Pillar-1 DESIGN (already approved, Scope C) concluded: a shared Python package
services/shared/capability_compiler/ (vendored into the Python services via scripts/sync-runtime-registry.mjs,
the same mechanism that vendors session_events/publisher.py), with pure per-target emitters returning
CompileResult(files, env, argv, sdk_options), driven by the runtime-registry capability descriptors
(services/shared/runtime-registry.json), reusing swap-safety.ts's severity vocabulary. ONE normalized
NormalizedMcpServer collapses the {transport} vs {type} shapes. Golden-file tests per target that first
reproduce today's output BYTE-FOR-BYTE (no behavior change), then close the skills gap for codex/agy.
`

phase('Investigate')

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    decision: { type: 'string', description: 'The concrete recommendation/decision with rationale' },
    plan: { type: 'array', items: { type: 'string' }, description: 'Concrete, file-anchored steps' },
    risks: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'string', description: 'Commands run + key output / source read' },
  },
  required: ['summary', 'decision', 'plan', 'risks', 'evidence'],
}

const [mcpserver, translators, skills] = await parallel([
  () => agent(`${CONTEXT}

YOUR TASK (Agent A — the dapr-agent-py MCP delivery decision): Decide whether dapr-agent-py should deliver
MCP via the Dapr 1.18 **MCPServer CRD** (auto-discovered by dapr-agents 1.0.4) INSTEAD OF / IN ADDITION TO
the current per-runtime mcpServers translation (_extract_mcp_server_configs + DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON).
1. Inspect the installed dapr-agents 1.0.4 source (in a venv: uv venv + uv pip install dapr-agents==1.0.4; or read
   the wheel) for the "MCPServer auto-discovery" feature: how does it discover MCPServers (Dapr metadata API? a
   specific client call?), what config does it need, and does it REPLACE or COMPLEMENT the existing
   mcp client our code wires (grep dapr_agents for MCPServer / metadata / mcp discovery).
2. Read the Dapr 1.18 MCPServer CRD schema (the rendered CRD from the helm chart, or
   /home/vpittamp/repos/PittampalliOrg/stacks/main — search for mcpservers.dapr.io) to understand: what an MCPServer
   resource declares (URL/transport/auth?), and CRITICALLY whether it supports OUR credential model — encrypted
   app_connections + per-request reference-forwarding (X-Connection-External-Id header → the piece-runtime
   self-resolves via the BFF /decrypt). If the MCPServer CRD can't carry our per-connection reference-forwarding auth,
   that's a blocker for adopting it for credentialed pieces.
3. Weigh: adopting MCPServer for dapr-agent-py would re-architect MCP delivery (new CRD lifecycle per agent/session,
   the auth question) vs the consolidation scope of Pillar 1 (just collapse the existing translators). 
4. DECIDE: (a) keep the per-runtime compiler emit for dapr-agent-py now + note MCPServer as a future enhancement, or
   (b) adopt MCPServer auto-discovery for dapr-agent-py (and what that requires). Justify with the credential-model finding.`,
    { label: 'mcpserver-decision', phase: 'Investigate', schema: FINDINGS_SCHEMA }),

  () => agent(`${CONTEXT}

YOUR TASK (Agent B — map the translators + design the compiler): Produce the PRECISE consolidation map + the shared
capability_compiler package design so implementation is mechanical.
1. Read all current MCP translation sites and record their EXACT input shape + output shape (file:line + excerpts):
   the 3 mcp_config.py build_mcp_servers; dapr-agent-py main.py _extract_mcp_server_configs; the 3 cli adapter seed()
   MCP emit blocks (claude_code .mcp.json, codex config.toml [mcp_servers], agy mcp_config.json serverUrl). Identify
   EXACTLY where they diverge ({transport} vs {type}, name derivation, header injection, url qualification, websocket).
2. Design services/shared/capability_compiler/: the normalize module (NormalizedMcpServer superset), the
   compile(canonical, target) dispatcher, per-target emitters (claude-agent-sdk, claude-code-cli, codex-cli, agy-cli,
   dapr-agent-py), the CompileResult shape (files/env/argv/sdk_options/dropped/warnings) with logical-path keys that
   MATCH the current SeedResult.paths so the cli_lifecycle seed_paths consumers are unchanged. Specify which current
   functions DELETE and how each caller (the 3 adapters.seed(), claude_sdk_runner build_claude_options,
   dapr-agent-py _extract_mcp_server_configs) is rewritten to call the compiler.
3. Specify the vendoring (extend scripts/sync-runtime-registry.mjs ASSETS, the precedent that vendors
   session_events/publisher.py) + the --check drift guard.
Provide a per-emitter byte-for-byte reproduction note (what golden output each must match today).`,
    { label: 'translator-map', phase: 'Investigate', schema: FINDINGS_SCHEMA }),

  () => agent(`${CONTEXT}

YOUR TASK (Agent C — close the skills gap for codex + agy + golden-test strategy): Today only claude_code.py
materializes agentConfig.skills; codex.py + antigravity.py DROP them. Design the closure.
1. Read claude_code.py's skill materialization (the caps: 128KB/file, 2MB total, 80 files; path-traversal guard;
   _safe_skill_segment etc.) + dapr-agent-py main.py's skill package materialization (_extract_skill_package_entries /
   _materialize_instance_skill_packages) — extract the shared caps/guard logic into the compiler's normalize core.
2. Research codex-cli + agy(antigravity)-cli native skill mechanisms (read the pinned codex 0.139.0 + agy behaviors —
   codex uses AGENTS.md + $CODEX_HOME; agy uses GEMINI.md + ~/.gemini; do they have a skills/ discovery dir, or must
   skills be written + indexed in the instruction file?). Decide each emitter's skill-emit (write skills/<slug>/ +
   append a "## Available skills" index to AGENTS.md/GEMINI.md, vs a native mechanism if one exists).
3. Design the golden-test strategy: a fixtures dir + per-target expected outputs; a parametrized (fixture × target)
   test asserting compile()==golden; the codex/agy SKILLS golden that FAILS on main today (gap proof) and passes after;
   the drift-guard integration (sync-runtime-registry.mjs --check).
Provide the concrete skills-emit plan per target + the test plan.`,
    { label: 'skills-and-tests', phase: 'Investigate', schema: FINDINGS_SCHEMA }),
])

phase('Synthesize')

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mcpserverDecision: { type: 'string', description: 'Final decision on the dapr-agent-py MCP path + why' },
    implementationPlan: { type: 'array', items: { type: 'string' }, description: 'Ordered, file-anchored Pillar-1 steps' },
    sequencing: { type: 'array', items: { type: 'string' }, description: 'Phased rollout (reproduce-byte-for-byte first, then close gaps)' },
    holes: { type: 'array', items: { type: 'string' }, description: 'Risks/gaps the investigators missed' },
  },
  required: ['mcpserverDecision', 'implementationPlan', 'sequencing', 'holes'],
}

const synthesis = await agent(`${CONTEXT}

Three investigators produced these findings for Pillar 1. SYNTHESIZE them into ONE actionable, file-anchored
Pillar-1 implementation plan, and ADVERSARIALLY check for holes (re-verify the riskiest claims with real commands).

=== Agent A (MCPServer/dapr-agents decision) ===
${JSON.stringify(mcpserver, null, 2)}

=== Agent B (translator map + compiler design) ===
${JSON.stringify(translators, null, 2)}

=== Agent C (skills gap + golden tests) ===
${JSON.stringify(skills, null, 2)}

Deliver: the final MCPServer decision; the ordered implementation plan (what to create/edit/delete, file-anchored);
the sequencing (Phase 1 = reproduce today's output byte-for-byte with NO behavior change + vendoring + goldens;
Phase 2 = cut over the 5 callers + delete the duplicates; Phase 3 = close the codex/agy skills gap); and the holes
(e.g. any caller whose output the compiler can't reproduce, the dapr-agent-py runtime.write_text mid-session skill
path, the {transport} vs {type} regression risk, the sync/vendoring drift). Verify the byte-for-byte feasibility for
at least the dapr-agent-py {transport} shape + one cli adapter by reading the exact current code.`,
  { label: 'pillar1-synthesis', phase: 'Synthesize', schema: PLAN_SCHEMA })

return { mcpserver, translators, skills, synthesis }