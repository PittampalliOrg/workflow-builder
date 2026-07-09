export const meta = {
  name: 'codex-kickoff-first-word-drop',
  description: 'Root-cause the codex kickoff first-word-drop and converge on a verified fix',
  phases: [
    { title: 'Investigate' },
    { title: 'Synthesize' },
  ],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const SUP = `${REPO}/services/cli-agent-py/src/session_supervisor.py`
const HERDR = `${REPO}/services/cli-agent-py/src/herdr_client.py`
const CODEX = `${REPO}/services/cli-agent-py/src/cli_adapters/codex.py`
const CLAUDE = `${REPO}/services/cli-agent-py/src/cli_adapters/claude_code.py`

const GROUND = `
CONTEXT — a CONFIRMED bug to root-cause (do NOT re-question whether it happens):
The interactive-cli kickoff (seed) message has its FIRST WORD + trailing space dropped before the CLI sees it.
Evidence (codex's OWN native rollout user_message, not our mirror):
  sent "Reply with exactly the single word: READY"  -> codex received "with exactly the single word: READY"
  sent "Reply with the single word READY and nothing else" -> codex received "with the single word READY and nothing else"
So EXACTLY the first whitespace-delimited token ("Reply ") is lost, consistently, for codex-cli.

What I already established (take as given):
- The kickoff marker is EMPTY: arm_seed(text, marker="") so _send_to_pane sends pane_send_text(pane, f"{marker}{text}") == just the text. The marker is NOT the cause.
- ${HERDR} pane_send_text just issues the herdr RPC "pane.send_text" with the full text as ONE blob (no chunking our side). pane_submit_enter sends keys ["Enter"].
- _send_to_pane (${SUP} ~line 544): pane_send_text(text) -> sleep CLI_SUBMIT_DELAY_SECONDS -> pane_submit_enter -> _confirm_submitted (re-press Enter if still idle).
- The injection code + its comments were written for the CLAUDE CODE Ink TUI ("ingests typed text via bracketed paste"). codex is a Rust/ratatui TUI and may handle paste/focus differently.
- The seed fires right after pane launch (_inject_seed -> _gated_send(timeout=CLI_SEED_READY_TIMEOUT) -> wait_until_ready then _send_to_pane). codex shows an intro/"Tip" panel at launch.

Files (read them — absolute paths):
  supervisor:    ${SUP}
  herdr client:  ${HERDR}
  codex adapter: ${CODEX}
  claude adapter:${CLAUDE}

You have Read/Grep/Bash (read-only). You MAY inspect the live cluster read-only with kubectl --context dev (a codex pod can be spawned but assume none is running; do NOT create sessions). Do NOT edit files.
`

phase('Investigate')

const FIND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    angle: { type: 'string' },
    mechanism: { type: 'string', description: 'precise mechanism by which the first token is lost (or why your angle does NOT explain it)' },
    supported: { type: 'boolean', description: 'does the evidence support THIS angle as the/a root cause' },
    locus: { type: 'string', description: 'file:line of the responsible code or timing window' },
    evidence_for: { type: 'string' },
    evidence_against: { type: 'string' },
    proposed_fix: { type: 'string', description: 'concrete code-level fix for this angle' },
    breaks_other_clis: { type: 'string', description: 'would this fix regress claude-code-cli or agy-cli? why/why not' },
    confidence: { type: 'number' },
  },
  required: ['angle', 'mechanism', 'supported', 'locus', 'evidence_for', 'proposed_fix', 'breaks_other_clis', 'confidence'],
}

const ANGLES = [
  {
    key: 'focus-paste-race',
    prompt: `ANGLE: Focus/paste timing race. The seed is sent the instant wait_until_ready reports idle, but codex's composer may not yet accept input (intro/Tip panel, focus transition, bracketed-paste not armed), so the LEADING token of the pasted blob is swallowed. Read ${SUP} fully: wait_until_ready, _gated_send, _send_to_pane, CLI_SUBMIT_DELAY_SECONDS, CLI_SEED_READY_TIMEOUT, CLI_READY_POLL_SECONDS, and the bracketed-paste comment (~line 76-90). Explain why a TIMING race would drop exactly the first whitespace token (not a random char count). Propose a robust fix (e.g., a warm-up no-op key/space+backspace to focus before the real paste, a pre-text settle delay, or a clear-composer keystroke). State whether it regresses claude/agy.`,
  },
  {
    key: 'content-verify-resend',
    prompt: `ANGLE: No content verification before submit. _confirm_submitted only checks agent status (idle->working) after Enter; it never verifies the COMPOSER actually contains the full text. So a truncated paste is submitted as-is. Read ${SUP} (_send_to_pane, _confirm_submitted) and ${HERDR} (pane_read/pane_send_text/pane_send_keys). Design a fix that, before pressing Enter, reads the pane composer (herdr pane.read source=visible) and if the text is missing/truncated, clears + re-sends (bounded retries). Give the concrete code shape. Note that the codex composer line is prefixed "› " in the TUI. State regression risk for claude/agy (the same verify-before-submit should be safe/beneficial for all).`,
  },
  {
    key: 'codex-tui-vs-ink',
    prompt: `ANGLE: codex(ratatui)-specific vs Claude(Ink). The injection was written for Claude's Ink TUI bracketed paste; codex may consume the first token differently (e.g., a leading char dismisses the intro/Tip overlay, or codex needs send-keys not a paste blob, or its first-render eats input). Read ${CLAUDE} and ${CODEX} seed/build_argv + ${SUP}. Determine: does claude-code-cli ALSO drop the first kickoff word, or is this codex-only? If codex-only, what is different (overlay dismissal? paste vs type? a required focus key?). If you can, inspect codex TUI behavior reasoning from its launch panel. Propose a codex-correct injection (e.g., send a harmless priming key first, or split: send a single space, backspace, then the text). State whether the fix should be codex-only (adapter-provided priming) or universal in the supervisor.`,
  },
]

const findings = await parallel(ANGLES.map((a) => () =>
  agent(`${GROUND}\n\n${a.prompt}\n\nReturn ONLY the structured finding.`, {
    label: `investigate:${a.key}`,
    phase: 'Investigate',
    schema: FIND_SCHEMA,
  })
))

const valid = findings.filter(Boolean)

phase('Synthesize')

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    root_cause: { type: 'string' },
    primary_fix_file: { type: 'string' },
    exact_change: { type: 'string', description: 'concrete before/after code (or new helper) to implement, precise enough to apply' },
    universal_or_codex_only: { type: 'string', enum: ['universal', 'codex-only'] },
    why_robust: { type: 'string' },
    regression_risk: { type: 'string', description: 'effect on claude-code-cli and agy-cli kickoff' },
    live_test_steps: { type: 'string', description: 'exact in-pod herdr commands to PROVE the fix (and to reproduce the bug first), runnable against a fresh codex pod' },
    confidence: { type: 'number' },
  },
  required: ['root_cause', 'primary_fix_file', 'exact_change', 'universal_or_codex_only', 'why_robust', 'regression_risk', 'live_test_steps', 'confidence'],
}

const synthesis = await agent(
  `${GROUND}\n\nThree investigators returned findings on the codex kickoff first-word-drop. Reconcile them into ONE implementable fix. Prefer a fix that is robust and does not regress claude/agy. If the cleanest fix is a content-verify-before-submit retry loop in _send_to_pane, favor it (it self-heals truncated pastes for ALL clis); if codex needs distinct priming, say so. Give an exact, applyable change and a live herdr test that first REPRODUCES then PROVES the fix.\n\nFINDINGS:\n${JSON.stringify(valid, null, 2)}\n\nReturn ONLY the structured synthesis.`,
  { label: 'synthesize-fix', phase: 'Synthesize', schema: SYNTH_SCHEMA },
)

return { findings: valid, synthesis }
