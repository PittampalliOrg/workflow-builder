export const meta = {
  name: 'review-dev-pin-ssot',
  description: 'Adversarial review of the dev-preview pin SSOT commit before PR',
  phases: [
    { title: 'Review', detail: '3 lenses over the commit diff' },
    { title: 'Verify', detail: 'adversarial verification of each finding' },
  ],
}

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'summary', 'failure_scenario', 'severity'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          summary: { type: 'string' },
          failure_scenario: { type: 'string', description: 'concrete inputs/state -> wrong behavior' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['isReal', 'reasoning'],
  properties: {
    isReal: { type: 'boolean', description: 'true only if the failure scenario actually occurs as described' },
    reasoning: { type: 'string' },
  },
}

const BASE = `Repo: /home/vpittamp/repos/PittampalliOrg/stacks/main, branch fix/dev-preview-image-pin-ssot. Review ONLY commit HEAD (git show HEAD; base is HEAD~1). READ-ONLY — do not modify anything.

CONTEXT: This commit makes the workflow-builder-dev preview image pin release-pins-driven. Pieces: (1) release-pins gains workflow-builder-dev + dev-sync-sidecar keys in all 6 sections; (2) scripts/gitops/render-workflow-builder-release-overlays.sh reads them via OPTIONAL pin_value lookups (ryzen/nix-ci pins files lack the keys and share the var block; write_overlay hard-fails instead) and the L~155 CLASSES_JSON heredoc now uses \${workflow_builder_dev_ref}/\${dev_sync_sidecar_ref}; (3) Task-update-dev-image-pins.yaml now has an idempotent apply_all() that seds 4 files + upserts release-pins + re-renders overlays, and a reset-to-origin+reapply push retry; (4) Task-update-stacks-image.yaml push retry converted the same way (its edits wrapped in apply_all()); (5) EventListener dev-images trigger uncommented; (6) new scripts/gitops/validate-workflow-builder-dev-pins.sh + .github/workflows/validate-workflow-builder-release-pins.yml wiring. A local simulation already proved: fake-digest apply_all moves all 7 @-digest sites + pins consistently, is idempotent, and validators + renderer --check pass — so don't re-litigate that happy path; hunt for what the simulation could NOT catch.

Also relevant invariants you may check against the repo: validate-workflow-builder-release-pins.sh enforces key parity across all 6 sections, images=tag-not-digest, digests empty-or-sha256, runs renderer --check with the MAIN pins file AND WFB_RENDER_ENVS=ryzen with the ryzen pins file, and skopeo-inspects EVERY images key (tag must exist in GHCR; digest compared when non-empty). There is also workflow-builder-images-nix-ci-candidates.yaml and scripts/gitops/validate-workflow-builder-release-pins-nix-ci-candidates.sh (check whether THAT path renders with the nix-ci pins file and would hit the new write_overlay hard-fail!). The hub-tekton manifests deploy via the hub source-hydrator; Tekton is v1; the tasks run in alpine/git:2.43.0 (busybox awk/sed + git, POSIX sh).`

const lenses = [
  { key: 'shell', prompt: BASE + `\n\nYOUR LENS: shell/awk/sed correctness in the two Tekton task scripts and the renderer change. Hunt: quoting/word-splitting bugs (e.g. unquoted \${GENERATED_OVERLAYS} with multi-line paths), busybox-awk compat of set_release_pin against the ACTUAL pins file content (values containing ':' like ghcr refs, the $(context...) literal values, quoted values), sed pattern collisions (could 'workflow-builder-dev@sha256:' match something unintended? does the orchestrator-dev/function-router-dev sed hit files it shouldn't?), the reset-and-reapply loop (does git fetch origin main update refs/remotes/origin/main in a --depth 10 clone? does reset --hard clear the index safely? can the loop exit wrongly?), set -eu pitfalls (unbound vars, early-exit inside functions), the renderer's new optional lookups + write_overlay guard under 'sh' strict mode, and whether exit-0 'No changes' paths can mask a real failure.` },
  { key: 'gitops', prompt: BASE + `\n\nYOUR LENS: GitOps/CI system semantics. Hunt: does the nix-ci-candidates validation path render with a pins file lacking the new keys (breaking CI via the write_overlay hard-fail)? Any OTHER caller of the renderer (grep the repo: scripts/, .github/, Tekton tasks, docs) that passes a pins file without the new keys? Does the GH workflow paths change accidentally trigger loops (lane commits now touch pins+overlays on every dev-images run -> validate workflow runs on push to main — fine — but does anything else fire on workflow-builder-system-overlays/** ?). Does the uncommented EventListener trigger reference bindings/templates that exist and are deployed (TriggerBinding workflow-builder-push, TriggerTemplate outer-loop-dev-images — check fields the template expects vs what the binding provides)? Is the hub-tekton kustomization including all these files (so the changes actually deploy)? Does the dev-images CEL filter overlap with prod triggers in a way that double-fires anything harmful? Will the validate-dev-pins gate false-fail on legitimate states (e.g. a wfb_dev_digest-empty lane run bumps only orch/fr tags — does that leave copies consistent)? Check the staging overlay: it is dormant/frozen and still contains OLD sidecar/digest values or none — does validate-workflow-builder-dev-pins.sh reference only the dev overlay (it should)?` },
  { key: 'runtime', prompt: BASE + `\n\nYOUR LENS: runtime/rollout consequences on the live dev cluster and previews. Hunt: the regenerated dev overlay changes the CLASSES_JSON lines (sidecar d6d13218->f79afd94) — enumerate exactly which Deployments roll on sync and any consumer of syncSidecarImage that could break on the newer sidecar (check what changed in the sidecar between those two wfb commits if determinable from the wfb repo at /home/vpittamp/repos/PittampalliOrg/workflow-builder/main — git log d6d13218..f79afd94 -- services/dev-sync-sidecar). Confirm the app-overlay path (vcluster) is UNCHANGED by this commit (no selfHeal churn into claimed vclusters incl. pool-5953 until the next lane run). Check the Pipeline param addition matches the Task param name exactly. Check that $(context.pipelineRun.name) is legal in a Pipeline task param (Tekton v1) — the OLD prod task used it in a Task env and it did NOT substitute (literal string in pins file!) — confirm the new wiring actually substitutes. Any risk from the trigger being live before the hub syncs the new Task (ordering: EventListener + Task update land in the same hub sync — can a push fire the OLD task with the NEW pipeline param -> param mismatch error?).` },
]

const results = await pipeline(
  lenses,
  l => agent(l.prompt, { label: `review:${l.key}`, phase: 'Review', schema: FINDINGS }),
  (rev, l) => rev && rev.findings.length
    ? parallel(rev.findings.map(f => () =>
        agent(BASE + `\n\nADVERSARIALLY VERIFY this ${f.severity} finding from a ${l.key}-lens reviewer. Default to isReal=false unless you can reproduce the failure scenario concretely from the actual repo state (read the files, run read-only git/shell to test claims — e.g. actually exercise an awk/sed snippet against the real file in a temp copy under /tmp).\n\nFINDING: ${f.summary}\nFILE: ${f.file}:${f.line ?? '?'}\nFAILURE SCENARIO: ${f.failure_scenario}`,
          { label: `verify:${l.key}`, phase: 'Verify', schema: VERDICT })
          .then(v => ({ ...f, lens: l.key, verdict: v }))))
    : [],
)

const all = results.filter(Boolean).flat().filter(Boolean)
return {
  confirmed: all.filter(f => f.verdict && f.verdict.isReal),
  rejected: all.filter(f => f.verdict && !f.verdict.isReal).map(f => ({ summary: f.summary, why: f.verdict.reasoning.slice(0, 300) })),
}