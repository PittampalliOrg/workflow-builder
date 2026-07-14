export const meta = {
  "name": "preview-gan-redesign",
  "description": "Comprehensive GAN frontend-redesign (Anthropic harness, V2-simplified) running INSIDE a Tier-2 vcluster preview. Planner authors a TESTABLE JSON contract (objective + acceptance criteria + a frontend-design token system + the frontend-design rubric); a two-pass design_review critiques the token system BEFORE any code (penalizing AI-default looks); then a refine loop has the GENERATOR pull the live source via GET /__export, edit the page rendered at targetRoute, and PUSH via POST /__sync (HMR) \u2014 STOPPING after sync (no slow self-verify) \u2014 while a skeptical Playwright critic LOGS IN, boots the l",
  "phases": [
    {
      "title": "Dev mode"
    },
    {
      "title": "Plan"
    },
    {
      "title": "Refine"
    }
  ],
  "input": {
    "type": "object",
    "required": [
      "intent"
    ],
    "properties": {
      "intent": {
        "type": "string",
        "title": "Change request",
        "default": "Describe the redesign you want for the target route (set \"Target route\" below). State the goal, what matters MOST to surface, and what to AVOID (noise/clutter). Requirements: pull REAL data via +page.server.ts (never fabricate; degrade gracefully to empty states), use progressive disclosure, a cohesive and distinctive visual design system, fully responsive and accessible. Keep existing functionality intact; never touch the sign-in/auth pages.",
        "description": "The change request that drives the loop: Planner writes a testable contract -> Generator builds it -> skeptical Playwright Critic grades it. Freeform; be specific about the goal and what to avoid."
      },
      "service": {
        "type": "string",
        "title": "Service",
        "default": "workflow-builder"
      },
      "targetRoute": {
        "type": "string",
        "title": "Target route",
        "default": "/dashboard"
      },
      "generatorAgent": {
        "type": "string",
        "title": "Generator/planner agent",
        "default": "gan-generator-claude"
      },
      "criticAgent": {
        "type": "string",
        "title": "Critic agent",
        "default": "gan-critic-claude"
      },
      "previewLogin": {
        "type": "string",
        "title": "Preview login email",
        "default": "admin@example.com"
      },
      "previewPassword": {
        "type": "string",
        "title": "Preview login password",
        "default": "developer"
      },
      "planAgent": {
        "type": "string",
        "default": "gan-planner-claude"
      }
    }
  }
}

// Ported from the SW 1.0 fixture (cutover P3, item 17). The jq `for`+`while`
// refine loop becomes a plain JS loop; the critic's verdict is schema'd (the
// SW gate parsed `.critique.meets_criteria` / `.score` out of free-form JSON —
// the exact failure mode the GAN forensics doc recorded). Prompts are verbatim.
const t = args ?? {}
const intent = t.intent ?? "Describe the redesign you want for the target route (set \"Target route\" below). State the goal, what matters MOST to surface, and what to AVOID (noise/clutter). Requirements: pull REAL data via +page.server.ts (never fabricate; degrade gracefully to empty states), use progressive disclosure, a cohesive and distinctive visual design system, fully responsive and accessible. Keep existing functionality intact; never touch the sign-in/auth pages."
const service = t.service ?? "workflow-builder"
const targetRoute = t.targetRoute ?? "/dashboard"
const generatorAgent = t.generatorAgent ?? "gan-generator-claude"
const criticAgent = t.criticAgent ?? "gan-critic-claude"
const previewLogin = t.previewLogin ?? "admin@example.com"
const previewPassword = t.previewPassword ?? "developer"
const planAgent = t.planAgent ?? "gan-planner-claude"
const maxIterations = Number(t.maxIterations ?? 5) || 5

phase('Dev mode')
const preview = await action('dev/preview', {
  service,
  mode: 'preview-native',
  adopt: false,
  timeoutSeconds: 86400,
  waitReadySeconds: 240,
}, { label: 'enter_dev_mode' })

const SANDBOX = { workspaceRef: workspace, cwd: '/sandbox/work' }

phase('Plan')
const plan = await agent("STEPS: (1) curl -sS -H \"x-sync-token: $SYNC_TOKEN\" \"$EXPORT_URL\" | tar -xz -C /sandbox/scratch/repo and READ the current page that renders the target route (understand the data/links/forms to preserve) \u2014 do not edit it. (2) mkdir -p /sandbox/work and WRITE /sandbox/work/contract.json (strict JSON), then cat it to verify. The contract has keys: objective (one sentence); subject, audience, pageJob; acceptanceCriteria (array of 5-8 {id,description,verify} TESTABLE on the live page \u2014 cover the four monitoring dimensions: what is running NOW, what happened RECENTLY, CAPACITY/usage, system HEALTH \u2014 plus one for focused/uncluttered with progressive disclosure, and one for visual excellence; this is a UNIFIED command center, NOT one-card-per-resource); designTokens {palette:4-6 {name,hex} (deliberate, not a generic AI default), typography {display,body,utility}, wireframe (ASCII), signature (the one memorable element)}; rubric (string: penalize AI-default looks; require deliberate type/spacing/contrast, visible keyboard focus, reduced-motion, real data with graceful empty states, active-voice copy). (3) STOP after writing + verifying the file. Do NOT write app code.", {
  label: 'plan',
  agent: planAgent,
  isolation: 'shared',
  sandbox: { ...SANDBOX, maxTurns: 12, timeoutMinutes: 20 },
})

const designReview = await agent("\n\nRead /sandbox/work/contract.json, review its designTokens against the rubric, and write your verdict to /sandbox/work/design-review.json per your instructions.", {
  label: 'design_review',
  agent: criticAgent,
  isolation: 'shared',
  sandbox: { ...SANDBOX, maxTurns: 6, timeoutMinutes: 15 },
})

phase('Refine')
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['meets_criteria'],
  properties: {
    meets_criteria: { type: 'boolean' },
    score: { type: 'number' },
    failing: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

let verdict = null
let iterations = 0
let lastGenerator = null

while (iterations < maxIterations) {
  const feedback = verdict
    ? `\n\nPREVIOUS CRITIC VERDICT (address every failing item):\n${JSON.stringify(verdict)}`
    : ''
  lastGenerator = await agent("HARD REQUIREMENT \u2014 this is NOT a row of one-card-per-resource and NOT a noisy wall of everything. Decide what is MOST important to a platform engineer operating this system and LEAD with it; expose secondary detail via PROGRESSIVE DISCLOSURE (expand / drill-down / hover / deep-link). At a glance it must answer: (a) WHAT IS RUNNING NOW (active sessions, in-flight workflow runs, live preview environments, in-progress deploys); (b) WHAT HAPPENED RECENTLY (a concise activity timeline/feed with outcomes); (c) CAPACITY & USAGE (agent fleet utilization, token/cost, resource pressure); (d) overall SYSTEM HEALTH \u2014 synthesized into ONE coherent operational narrative, not siloed boxes.\n\n" + feedback, {
    label: `generate #${iterations + 1}`,
    phase: 'Refine',
    agent: generatorAgent,
    isolation: 'shared',
    sandbox: { ...SANDBOX, maxTurns: 30, timeoutMinutes: 25 },
  })

  // Per-iteration promotable snapshot (workspace/snapshot in the SW spec).
  await action('workspace/snapshot', {
    workspaceRef: workspace,
    label: `iteration-${iterations + 1}`,
  }, { label: `snapshot #${iterations + 1}`, phase: 'Refine', allowFailure: true })

  verdict = await agent("REQUIRED \u2014 grade whether this is a genuinely useful, FOCUSED, UNIFIED monitoring command center (single pane of glass), NOT a row of per-resource cards and NOT a noisy/cluttered wall. Leading with the highest-signal summary, a platform engineer must see at a glance: (1) WHAT IS RUNNING NOW; (2) WHAT HAPPENED RECENTLY (timeline/feed + outcomes); (3) CAPACITY & USAGE (fleet utilization, token/cost, pressure); (4) overall SYSTEM HEALTH. Secondary detail should be reachable via progressive disclosure rather than dumped on screen. Verify each dimension shows REAL data or a graceful empty state, the whole reads as ONE cohesive meaningful experience (not siloed, not cluttered), and it is visually STUNNING (deliberate palette/typography/spacing, strong hierarchy, NO generic AI-default look, a signature element, live feel, AA contrast, visible keyboard focus, responsive).\n\n", {
    label: `critique #${iterations + 1}`,
    phase: 'Refine',
    agent: criticAgent,
    isolation: 'shared',
    schema: VERDICT_SCHEMA,
    sandbox: { ...SANDBOX, maxTurns: 24, timeoutMinutes: 25 },
  })

  iterations += 1
  // The SW `while` gate: accept only on meets_criteria AND a passing score.
  if (verdict?.meets_criteria === true && (verdict?.score ?? 0) >= 8) break
}

return {
  accepted: verdict?.meets_criteria === true && (verdict?.score ?? 0) >= 8,
  iterations,
  service,
  targetRoute,
  preview,
  verdict,
  plan: typeof plan === 'string' ? plan.slice(0, 4000) : plan,
  designReview: typeof designReview === 'string' ? designReview.slice(0, 4000) : designReview,
  generatorSummary: typeof lastGenerator === 'string' ? lastGenerator.slice(0, 4000) : lastGenerator,
}
