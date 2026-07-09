export const meta = {
  name: 'capability-followup-understand',
  description: 'Map the surfaces for the capability-bundles Pillar-3 follow-up and synthesize an actionable plan',
  phases: [
    { title: 'Map', detail: '4 parallel surface readers' },
    { title: 'Synthesize', detail: 'actionable, file-anchored follow-up plan' },
  ],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'

const SURFACE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    surface: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string' }, role: { type: 'string' } },
        required: ['path', 'role'],
      },
    },
    anchors: {
      type: 'array',
      description: 'file:line anchors + what is there',
      items: {
        type: 'object', additionalProperties: false,
        properties: { ref: { type: 'string' }, what: { type: 'string' } },
        required: ['ref', 'what'],
      },
    },
    approach: { type: 'string', description: 'exact concrete edit approach for the follow-up' },
    typeOrApiChanges: { type: 'string', description: 'any type/AgentOverrides/API changes needed, or "none"' },
    risks: { type: 'string' },
  },
  required: ['surface', 'files', 'anchors', 'approach', 'typeOrApiChanges', 'risks'],
}

const ctx = `Context: a capability-bundles feature just landed (PR #138). \`AgentConfig.bundleRefs?: BundleRef[]\` flattens via \`flattenBundles()\` at spawn (src/lib/server/sessions/spawn.ts + src/lib/server/agents/resolver.ts). A working attach component exists: src/lib/components/capabilities/bundle-refs-picker.svelte (props {value: BundleRef[], onChange, projectId?}), already wired into the agent Capabilities tab (src/routes/workspaces/[slug]/agents/[id]/+page.svelte). API: /api/capability-bundles. cwd=${REPO}. Read files, do NOT edit. Give exact file:line anchors.`

phase('Map')
const [drawer, node, pickers, surface] = await parallel([
  () => agent(`${ctx}\n\nTASK: Map how to add a BundleRefsPicker to the SESSION config drawer so a session can attach bundles on top of the agent's. Read src/lib/components/sessions/session-config-drawer.svelte: find where draftConfig (an AgentConfig) is edited, the patchConfig pattern, the capability/tools section, and the EXACT insertion point + props for a BundleRefsPicker bound to draftConfig.bundleRefs. Confirm the session POST body carries agentConfig (so bundleRefs flow to spawn). Note the projectId available in that component.`, { label: 'session-drawer', phase: 'Map', schema: SURFACE_SCHEMA }),

  () => agent(`${ctx}\n\nTASK: Map how to add bundle attachment to the workflow durable/run NODE config. Read src/lib/components/workflow/config/sw-agent-config.svelte: find the overrides section (tools/maxTurns/etc), how overrides are written back to taskConfig.with.body, and whether node-level overrides currently carry bundleRefs. Determine: does the orchestrator/resolver apply node-level bundleRefs? Check src/lib/server/agents/resolver.ts applyOverrides (line ~441) + the AgentOverrides type — does it include bundleRefs? Report the exact edit to (a) add bundleRefs to AgentOverrides + applyOverrides, and (b) add a BundleRefsPicker to the node config UI. Note: the agent's OWN bundles already flatten; this is for ADDITIONAL node-level bundles.`, { label: 'workflow-node', phase: 'Map', schema: SURFACE_SCHEMA }),

  () => agent(`${ctx}\n\nTASK: Find EVERY native <select> used as an agent picker (the plan calls out "two native <select>s") and assess building one reusable AgentPicker combobox. Search src/lib/components/ + src/routes/ for agent <select> pickers (likely in sw-agent-config.svelte + session-config-drawer.svelte or an agent chooser). For each: file:line + the options source (how it lists agents) + the bind/onChange. Then inventory the available shadcn-svelte combobox primitives (src/lib/components/ui/command, popover, etc.) to build an AgentPicker.svelte. Report the exact props an AgentPicker should expose + which <select>s it would replace.`, { label: 'agent-pickers', phase: 'Map', schema: SURFACE_SCHEMA }),

  () => agent(`${ctx}\n\nTASK: Assess extracting a single reusable CapabilitiesSurface.svelte from the agent Capabilities tab so the agent tab + session drawer + workflow node render the SAME capability editor. Read the Capabilities tab in src/routes/workspaces/[slug]/agents/[id]/+page.svelte (the Collapsible sections: builtin tools, AgentToolsIntegrations, skills, bundles, hooks, plugins) + how updateConfig works. Determine the component boundary: which sections are agent-only vs universally reusable, the props a CapabilitiesSurface would take (config + onChange + flags for which sections to show), and whether this is worth doing now vs leaving the per-surface components. Be honest about effort vs value.`, { label: 'capabilities-surface', phase: 'Map', schema: SURFACE_SCHEMA }),
])

phase('Synthesize')
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    pieces: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          change: { type: 'string' },
          value: { type: 'string', enum: ['high', 'medium', 'low'] },
          effort: { type: 'string', enum: ['small', 'medium', 'large'] },
          recommended: { type: 'boolean' },
        },
        required: ['title', 'files', 'change', 'value', 'effort', 'recommended'],
      },
    },
    sequencing: { type: 'array', items: { type: 'string' } },
    holes: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string' },
  },
  required: ['pieces', 'sequencing', 'holes', 'recommendation'],
}

const plan = await agent(
  `${ctx}\n\nYou are synthesizing a Pillar-3 follow-up plan from 4 surface maps. Produce a prioritized, file-anchored implementation plan. Recommend WHICH pieces to implement now (value vs effort) and the order. Flag holes (e.g. does node-level bundleRefs actually flow through the orchestrator's durable/run body to the resolver? is the session-drawer projectId real?).\n\nSESSION-DRAWER MAP:\n${JSON.stringify(drawer)}\n\nWORKFLOW-NODE MAP:\n${JSON.stringify(node)}\n\nAGENT-PICKERS MAP:\n${JSON.stringify(pickers)}\n\nCAPABILITIES-SURFACE MAP:\n${JSON.stringify(surface)}`,
  { label: 'synthesis', phase: 'Synthesize', schema: PLAN_SCHEMA },
)

return { drawer, node, pickers, surface, plan }
