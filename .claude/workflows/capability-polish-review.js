export const meta = {
  name: 'capability-polish-review',
  description: 'Adversarially verify the AgentPicker + CapabilitiesSurface refactor preserves behavior',
  phases: [{ title: 'Verify', detail: '2 adversarial verifiers' }],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const VERDICT = {
  type: 'object', additionalProperties: false,
  properties: {
    piece: { type: 'string' },
    traced: { type: 'string' },
    verdict: { type: 'string', enum: ['sound', 'broken', 'risk'] },
    issues: { type: 'array', items: { type: 'string' } },
    fixes: { type: 'array', items: { type: 'string' } },
  },
  required: ['piece', 'traced', 'verdict', 'issues', 'fixes'],
}
const base = `cwd=${REPO}. An opportunistic UI polish just landed (uncommitted). Read the ACTUAL code; do NOT edit. Be a skeptic — find BEHAVIOR REGRESSIONS vs the pre-refactor code (use git diff to compare). Default to risk/broken if anything differs functionally; "sound" only if behavior is preserved.`

phase('Verify')
const verdicts = await parallel([
  () => agent(`${base}\n\nPIECE A — CapabilitiesSurface extraction. NEW: src/lib/components/capabilities/capabilities-surface.svelte renders config-keyed sections (builtinTools/toolsIntegrations/callableAgents/repositories/skills/bundles/hooks/plugins) in 'collapsible' or 'flat' variant, calling onPatch(Partial<AgentConfig>). ADOPTED in: (1) the agent Capabilities tab src/routes/workspaces/[slug]/agents/[id]/+page.svelte — TWO instances around the inline Vaults Collapsible (first: builtinTools+toolsIntegrations openFirst default; second: callableAgents..plugins openFirst=false); (2) the session drawer src/lib/components/sessions/session-config-drawer.svelte — variant='flat' with sections [skills,toolsIntegrations,hooks,callableAgents,bundles]. VERIFY via \`git diff\`: (i) every section's value + onChange handler is IDENTICAL to the pre-refactor inline version (e.g. agent tab used updateConfig(key,next), surface uses onPatch={patchConfig} → patchConfig({key:next}); drawer used patchConfig(key,v), now onPatch={(p)=>draftConfig={...draftConfig,...p}} — are these equivalent? does the drawer still mark dirty / recompute the diff?); (ii) section ORDER is preserved on BOTH surfaces; (iii) the agent tab's builtin-tools toggle still works (BUILTIN_TOOLS moved into the surface — same 6 tools? toggle logic identical?); (iv) per-section props are threaded correctly (toolsIntegrations connectionMode/vaultIds; callableAgents selfSlug/projectId — agent tab passed projectId=registryView?.team, does the surface get it?; repositories workspaceSlug); (v) the Vaults section (agent-only) still renders inline + writes agent.defaultVaultIds; (vi) open/collapsed state matches (only builtin-tools open originally). List any divergence.`, { label: 'capabilities-surface', phase: 'Verify', schema: VERDICT }),

  () => agent(`${base}\n\nPIECE B — AgentPicker combobox. NEW: src/lib/components/agents/agent-picker.svelte (Popover+Command, props {value, agents, onChange(id,agent), disabled?, placeholder?}). REPLACED two native <select>s: (1) src/lib/components/workflow/config/sw-agent-config.svelte (was value={agentRef?.id} onchange→setAgent; now AgentPicker value={agentRef?.id ?? null} onChange={(id)=>setAgent(id)}); (2) src/routes/workspaces/[slug]/sessions/new/+page.svelte (was bind:value={agentId}; now value={agentId||null} onChange={(id)=>agentId=id}). VERIFY via \`git diff\`: (i) selecting an agent still updates the same state (agentRef via setAgent / agentId) — for sessions/new, was agentId a bound string that other code reads (selectedAgent $derived, the submit handler)? does onChange={(id)=>agentId=id} keep it in sync? (ii) the disabled={loading} behavior preserved on sessions/new; (iii) the empty/initial state (no agent selected) renders the placeholder, not a broken value; (iv) Command.Item filtering works (value={name+slug}); (v) any consumer that relied on the <select> being a form element or on bind:value two-way semantics. (vi) Does AgentPicker handle the agents list being empty/loading? List divergences.`, { label: 'agent-picker', phase: 'Verify', schema: VERDICT }),
])
const problems = verdicts.filter(Boolean).filter((v) => v.verdict !== 'sound')
return { verdicts, problems }
