export const meta = {
  name: 'diagnose-quickshell-launcher',
  description: 'Find why QuickShell launcher app launches fail while i3pm launch open works selectively, via parallel code+git+live investigation, synthesis, and adversarial verification',
  phases: [
    { title: 'Investigate', detail: 'parallel: quickshell launch path, i3pm launch internals, git history (window mgmt + quickshell/registry), live diagnostics' },
    { title: 'Synthesize', detail: 'correlate findings into a ranked root cause + concrete fix' },
    { title: 'Verify', detail: 'adversarially confirm/refute the root cause against the live system' },
  ],
}

const REPO = '/home/vpittamp/repos/vpittamp/nixos-config/main'
const CTX = `
Environment context (verified earlier this session):
- Repo: ${REPO} (NixOS flake config). Branch main. Working tree has UNCOMMITTED edits to home-modules/desktop/sway.nix (a prior fix that removed Ryzen output-disable lines + restored 3-monitor default profile).
- Host: ryzen desktop. SWAYSOCK=/run/user/1000/sway-ipc.1000.5465.sock ; WAYLAND_DISPLAY=wayland-1 ; XDG_RUNTIME_DIR=/run/user/1000 ; DISPLAY=:0
- Compositor: Sway. Active project (i3pm): "PittampalliOrg/stacks:main".
- Launcher: the primary app launcher is the QuickShell runtime shell, invoked by the keybinding command "toggle-app-launcher" (Walker is only a fallback when hasRuntimeShell is false). QuickShell shell code lives under home-modules/desktop/quickshell-runtime-shell/.
- i3pm: daemon is Python (i3_project_daemon, systemd user unit "i3-project-daemon.service"), CLI is Deno/TypeScript ("i3pm"). App→workspace/monitor registry generated from Nix into ~/.config/sway/workspace-assignments.json. App registry data: home-modules/desktop/app-registry-data.nix and app-registry.nix.
- Elephant (launcher backend) + Walker are systemd user services; elephant loads 196 desktop files fine.
- KEY SYMPTOM (user-reported): launching apps via the QuickShell launcher does NOT work. Running "i3pm launch open <app>" from a shell works only SELECTIVELY (some apps yes, some no). "i3pm launch open terminal" was verified to open a ghostty window successfully.
- Goal: find the regression (likely a recent commit to window management / quickshell / app-registry / i3pm launch) that broke the QuickShell launcher launch path, and how to fix it.

Investigation rules:
- Use Bash for live state. Export SWAYSOCK/WAYLAND_DISPLAY/XDG_RUNTIME_DIR before swaymsg or launching.
- When reading code, cite file:line. When citing live state, include the exact command + key output.
- For git history, use: git -C ${REPO} log --oneline -40 -- <paths>, git show <hash> -- <path>, git log -p -S '<symbol>'. Convert findings to concrete commit hashes + what changed.
- Be concrete and skeptical; distinguish "confirmed by evidence" from "hypothesis".
`

const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  required: ['area', 'summary', 'findings', 'rootCauseHypotheses'],
  properties: {
    area: { type: 'string' },
    summary: { type: 'string', description: 'tight prose summary of what you found' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['claim', 'evidence', 'confidence'],
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'string', description: 'file:line or exact command + output' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    launchChain: { type: 'string', description: 'the exact invocation chain for opening an app via this path, step by step (if applicable)' },
    suspiciousCommits: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['hash', 'subject', 'why'],
        properties: { hash: { type: 'string' }, subject: { type: 'string' }, why: { type: 'string' } },
      },
    },
    rootCauseHypotheses: { type: 'array', items: { type: 'string' } },
  },
}

phase('Investigate')
const investigations = await parallel([
  () => agent(`${CTX}

YOUR TASK (area = "quickshell-launch-path"): Trace EXACTLY how opening an application through the QuickShell launcher works, end to end.
- Find the QuickShell launcher UI component under home-modules/desktop/quickshell-runtime-shell/ (look for the app launcher / app-grid / Elephant-or-registry-backed list and the "activate/launch/onClicked" handler).
- Determine precisely what the launcher executes when the user picks an app: does it call "i3pm launch ..."? a D-Bus/socket call to the i3pm daemon? Quickshell Process/exec? a helper script (e.g. toggle-app-launcher, a launch action, app-registry sync)? Identify the literal command string / IPC method and its arguments.
- Find where the list of apps comes from (app-registry-data.nix / a generated JSON / elephant) and how each entry's launch command is derived.
- Compare this to the "i3pm launch open <app>" CLI path. Note any divergence (different subcommand, different arg format, different transport, a field the launcher passes that the CLI doesn't, etc.).
- Also gather live: journalctl --user -u quickshell-runtime-shell.service -n 120 --no-pager (look for launch errors/exceptions when an app is picked); ps/pgrep for the quickshell process; check the toggle-app-launcher script contents.
Return the full launchChain and any discrepancy that would make launcher launches fail while CLI works.`, { label: 'quickshell-launch-path', phase: 'Investigate', schema: FINDINGS }),

  () => agent(`${CTX}

YOUR TASK (area = "i3pm-launch-internals"): Determine why "i3pm launch open <app>" works only SELECTIVELY, and document the launch entrypoint the daemon owns.
- Find the i3pm CLI "launch" command source (Deno/TypeScript) and the daemon-side launch handler (Python i3_project_daemon: launch_registry / launch service / ipc_server method like "launch.open"). Cite files.
- Determine how an app NAME maps to an actual command/transport: the registry (app-registry-data.nix → workspace-assignments.json and/or a separate app-command registry), the "transport_kind" (local_process vs ssh), terminal anchors, and expected_class.
- Identify what distinguishes apps that launch vs apps that don't (e.g., only registry-known app_names work; GUI apps vs terminal apps; apps requiring a project/worktree context; SSH/remote transport apps; apps whose Exec/command resolves to a missing binary or store path).
- LIVE TEST: export SWAYSOCK/WAYLAND_DISPLAY/XDG_RUNTIME_DIR, then run "i3pm launch open <name>" for a spread of names (e.g. terminal, code, firefox, ghostty, yazi, lazygit, nvim, and one bogus name). Capture the JSON status/error for each. Wait ~3s and check 'swaymsg -t get_tree' for whether a window actually appeared. Report a per-app table: name -> CLI success? -> window appeared? -> error.
- Clean up any windows you spawn (swaymsg '[app_id="..."] kill').
Return the mapping logic and the precise selective-failure rule, with the live per-app results as evidence.`, { label: 'i3pm-launch-internals', phase: 'Investigate', schema: FINDINGS }),

  () => agent(`${CTX}

YOUR TASK (area = "git-history-window-management"): Review git history for changes to Sway window management that could break opening applications.
- Inspect recent history (last ~50 commits, and anything in the last ~6 weeks) for these paths: modules/desktop/sway.nix, home-modules/desktop/sway.nix, home-modules/desktop/sway-keybindings.nix, anything matching *workspace*assignment*, monitor profile / role-resolver, and the i3pm daemon handlers for window::new / workspace assignment.
- Look specifically for: changes to how new windows are placed/moved (auto_reassign, force-move, scratchpad/scoping that could hide windows), focus_on_window_activation, output enable/disable, "for_window" rules, swaymsg exec wrappers, and any change to the launch correlation / mark injection logic.
- Use: git -C ${REPO} log --oneline -50 -- <paths> ; git show <hash> ; git log -p -S 'auto_reassign' ; git log -p -S 'focus_on_window_activation' ; git log -p -S 'launch'.
- For each suspicious commit, give hash + subject + exactly what changed + why it could break launching (especially launcher-initiated launches vs CLI launches).
Return suspiciousCommits ranked by likelihood, with evidence.`, { label: 'git-window-mgmt', phase: 'Investigate', schema: FINDINGS }),

  () => agent(`${CTX}

YOUR TASK (area = "git-history-quickshell-registry"): Review git history for changes to the QuickShell launcher, the app registry, and the launch helper scripts/IPC.
- Inspect recent history for: home-modules/desktop/quickshell-runtime-shell/** (especially launcher / app-grid / launch-action QML and any embedded shell/exec), home-modules/desktop/app-registry*.nix, home-modules/desktop/walker.nix, the toggle-app-launcher script, and any i3pm "launch" IPC method or socket-path change.
- Pay special attention to the recent Herdr-integration commits and "harden QuickShell" commits (e.g. 3814b6ed, 2e915227, 0caa8565, and similar), and any commit that changed how the launcher calls i3pm / the daemon socket / the launch action, changed an app-command field, or changed an exec from direct to daemon-routed (the walker config notes launches "now route through i3pm launch").
- Use git log --oneline, git show, and git log -p -S '<symbol>' for symbols like 'toggle-app-launcher', 'launch', 'i3pm', 'exec', 'Process', 'socket'.
- LIVE: confirm the toggle-app-launcher command exists in PATH and what it points to; check whether the launcher's launch action matches the current daemon IPC/CLI contract.
Return suspiciousCommits ranked by likelihood that they broke the QuickShell launcher launch path, with concrete diffs as evidence.`, { label: 'git-quickshell-registry', phase: 'Investigate', schema: FINDINGS }),

  () => agent(`${CTX}

YOUR TASK (area = "live-diagnostics"): Capture what actually happens on the live system when launching via QuickShell vs CLI, to localize the break.
- Service health: systemctl --user status quickshell-runtime-shell elephant walker i3-project-daemon (note PIDs, restarts, failures). systemctl --user --failed.
- QuickShell logs: journalctl --user -u quickshell-runtime-shell.service -n 200 --no-pager — search for launch attempts, QML errors, "Process", "exec", failed launches, missing-binary, permission, or socket errors. Use grep patterns.
- Daemon launch path: journalctl --user -u i3-project-daemon.service -n 120 --no-pager — look for "launch", "User intent ... method=launch", "Registered launch", correlation, or errors.
- i3pm runtime health: i3pm daemon status ; i3pm health (if present) ; i3pm diagnose health.
- Determine the launcher's actual launch invocation: find and read the toggle-app-launcher script and any launch-action helper it calls; if the launcher writes to a socket or runs a command, identify it. If safe, reproduce that exact command from the shell (export SWAYSOCK/WAYLAND_DISPLAY/XDG_RUNTIME_DIR) for ONE app and report stdout/stderr/exit and whether a window appears.
- Check the i3pm daemon socket path the CLI/daemon use vs what the launcher uses (mismatch = launcher can't reach daemon). ls -la /run/user/1000/i3-project-daemon/ and /run/user/1000/i3pm-quickshell/.
Clean up any windows you spawn. Return concrete observations (commands + output) and your best localization of WHERE the launcher path breaks.`, { label: 'live-diagnostics', phase: 'Investigate', schema: FINDINGS }),
])

const ok = investigations.filter(Boolean)

phase('Synthesize')
const SYNTHESIS = {
  type: 'object', additionalProperties: false,
  required: ['rootCause', 'confidence', 'evidence', 'fix', 'fixFiles', 'verificationSteps'],
  properties: {
    rootCause: { type: 'string', description: 'the single most-likely root cause, specific and mechanistic' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: { type: 'array', items: { type: 'string' } },
    culpritCommits: { type: 'array', items: { type: 'string' }, description: 'hash + subject' },
    alternativeHypotheses: { type: 'array', items: { type: 'string' } },
    fix: { type: 'string', description: 'concrete fix: what file(s) to change and how, or what command/config corrects it' },
    fixFiles: { type: 'array', items: { type: 'string' } },
    verificationSteps: { type: 'array', items: { type: 'string' } },
  },
}
const synthesis = await agent(`${CTX}

You are the synthesis lead. Below are structured findings from 5 parallel investigators (quickshell launch path, i3pm launch internals, git window-mgmt history, git quickshell/registry history, live diagnostics). Correlate them into ONE mechanistic root cause for why QuickShell-launcher app launches fail while "i3pm launch open" works selectively.

Reason about the JOIN between the launch path and the selective CLI failure: e.g. does the launcher pass app identifiers/args/transport that only some registry entries satisfy? Did a commit change the daemon IPC/socket/launch-action contract so the launcher's call no longer matches? Did app-registry generation drift from what the launcher expects?

Produce: the root cause (specific + mechanistic), confidence, the culprit commit(s), the concrete fix (files + how), and step-by-step verification commands. Prefer a fix that aligns the launcher path with the working CLI path. If the evidence supports more than one cause, give the top one plus alternativeHypotheses.

INVESTIGATOR FINDINGS (JSON):
${JSON.stringify(ok, null, 2)}`, { label: 'synthesis', phase: 'Synthesize', schema: SYNTHESIS })

phase('Verify')
const VERDICT = {
  type: 'object', additionalProperties: false,
  required: ['confirmed', 'reasoning'],
  properties: {
    confirmed: { type: 'boolean', description: 'true if the root cause holds up against live re-checking and code, false if refuted' },
    reasoning: { type: 'string' },
    correction: { type: 'string', description: 'if refuted or partially wrong, the corrected root cause' },
    fixAssessment: { type: 'string', description: 'is the proposed fix correct and sufficient? what is missing or risky?' },
    additionalEvidence: { type: 'array', items: { type: 'string' } },
  },
}
const verdict = await agent(`${CTX}

You are an adversarial verifier. A synthesis lead proposed this root cause and fix for the broken QuickShell launcher. Your job is to REFUTE it if you can. Default to skepticism: re-derive the launcher's actual launch invocation from the code/live system independently, and test whether the proposed root cause truly explains BOTH (a) launcher launches failing AND (b) "i3pm launch open" working only selectively.

Concretely:
- Re-read the launcher launch handler and confirm/deny the claimed invocation chain.
- If the root cause names a commit, git show it and confirm the diff actually causes the described break.
- If feasible and safe, reproduce the launcher's exact launch command from a shell (export SWAYSOCK/WAYLAND_DISPLAY/XDG_RUNTIME_DIR) and observe pass/fail + whether a window appears. Clean up spawned windows.
- Assess whether the proposed fix actually resolves it without breaking the working CLI path.
Set confirmed=true ONLY if the root cause survives. Otherwise set confirmed=false and give the corrected root cause.

PROPOSED ROOT CAUSE + FIX (JSON):
${JSON.stringify(synthesis, null, 2)}`, { label: 'verify-root-cause', phase: 'Verify', schema: VERDICT })

return { investigations: ok, synthesis, verdict }
