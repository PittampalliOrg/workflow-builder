export const meta = {
  name: 'capability-followup-review',
  description: 'Adversarially verify the 3 Pillar-3 follow-up pieces trace correctly end-to-end',
  phases: [{ title: 'Verify', detail: '3 adversarial verifiers, one per piece' }],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const VERDICT = {
  type: 'object', additionalProperties: false,
  properties: {
    piece: { type: 'string' },
    traced: { type: 'string', description: 'the exact data-flow you traced, with file:line' },
    verdict: { type: 'string', enum: ['sound', 'broken', 'risk'] },
    issue: { type: 'string', description: 'the concrete bug/regression if any, else "none"' },
    fix: { type: 'string', description: 'the minimal fix if verdict != sound, else "none"' },
  },
  required: ['piece', 'traced', 'verdict', 'issue', 'fix'],
}

const base = `cwd=${REPO}. A capability-bundles follow-up just landed (uncommitted). Read the actual code; do NOT edit. Be a skeptic — try to REFUTE correctness. Default to "risk"/"broken" if the trace has a real gap; only "sound" if you traced it end-to-end and it holds.`

phase('Verify')
const verdicts = await parallel([
  () => agent(`${base}\n\nPIECE 1 (diff fix): src/lib/utils/agent-config-diff.ts now has diffBundleRefs + a "bundles" group, called from diffAgentConfig, and "bundles" added to summarizeDiff's ordered list. VERIFY: (a) diffBundleRefs correctly flags add/remove/version-change so isAgentConfigEquivalent returns false on any bundleRefs change; (b) the "bundles" ConfigDiffGroup is consistently added everywhere it must be (type union, summarizeDiff ordered, groupDiff — does groupDiff or any UI consumer switch on group and now need a "bundles" case?); (c) no other consumer of ConfigDiffGroup (e.g. a diff-rendering component) breaks or silently omits the new group. Grep for ConfigDiffGroup usages.`, { label: 'piece1-diff', phase: 'Verify', schema: VERDICT }),

  () => agent(`${base}\n\nPIECE 2 (session drawer): src/lib/components/sessions/session-config-drawer.svelte now renders a BundleRefsPicker bound to draftConfig.bundleRefs via patchConfig. VERIFY THE FULL FLOW a bundle change takes to actually affect a spawned session: patchConfig -> draftConfig -> submit() (line ~125-179) -> does it include body.agentConfig now that diffAgentConfig walks bundleRefs? -> POST /api/v1/sessions -> experiment-agent creation -> spawn.ts flattenBundles. Find ANY gate that could still drop a bundle-only change (e.g. a separate 'hasChanges' check, an ignore-list, a field allowlist on the POST body, fork vs create paths). Confirm projectId passed to the picker is correct for both the agent-detail and session-detail callers.`, { label: 'piece2-drawer', phase: 'Verify', schema: VERDICT }),

  () => agent(`${base}\n\nPIECE 3 (workflow node): (a) src/lib/types/agents.ts AgentOverrides gained bundleRefs; (b) src/lib/server/agents/resolver.ts applyOverrides is now async(config, overrides, projectId) and flattens overrides.bundleRefs onto the already-flattened config, caller at ~line 202 awaits it; (c) sw-agent-config.svelte writes overrides.bundleRefs via setOverride. VERIFY: (i) applyOverrides has EXACTLY ONE caller and it is awaited (grep all callers); (ii) pickOverrides passes bundleRefs through untouched (it casts the whole overrides object — confirm); (iii) the node-level bundleRefs actually reach the runtime — trace resolveSpecAgentRefs output into with.body and confirm the flattened config (with node bundle capabilities merged) is what ships, NOT the raw overrides; (iv) does any runtimeOverridePolicy gate block bundle overrides (like allowToolNarrowing blocks tools)? (v) the setOverride('bundleRefs', undefined-when-empty) correctly removes the key. Flag any place node bundleRefs get dropped.`, { label: 'piece3-node', phase: 'Verify', schema: VERDICT }),
])

const real = verdicts.filter(Boolean).filter((v) => v.verdict !== 'sound')
return { verdicts, problems: real }
