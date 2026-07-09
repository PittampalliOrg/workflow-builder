export const meta = {
  name: 'explore-session-stats-ui',
  description: 'Map data sources + UI primitives for a first-class session stats strip',
  phases: [{ title: 'Explore', detail: 'parallel read-only exploration' }],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const OUT = {
  type: 'object', additionalProperties: false,
  required: ['findings', 'keyFiles', 'recommendation'],
  properties: {
    findings: { type: 'string' },
    keyFiles: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file','detail'], properties: { file: {type:'string'}, lines: {type:'string'}, detail: {type:'string'} } } },
    recommendation: { type: 'string' },
  },
}
const COMMON = `Repo: ${REPO}. READ-ONLY exploration for a UI feature: a first-class metrics strip on the session detail page (src/routes/workspaces/[slug]/sessions/[id]/+page.svelte) showing tokens used, cache-hit %, context-window %, elapsed time, turns, goal-loop iterations. Cite exact files+lines+payload shapes. Be thorough but focused.`

const results = await parallel([
  () => agent(`${COMMON}
TASK 1 — DATA: What live per-session metrics data exists?
1. The 'agent.context_usage' session event — find where dapr-agent-py emits it (services/dapr-agent-py/src/, grep context_usage) and its EXACT data payload fields (context tokens used? limit? percentage?). Quote the emit site.
2. The 'agent.llm_usage' event payload fields (input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, ttft_ms, model) — confirm + where the PAGE or session-stream store currently aggregates them, if at all.
3. sessions.usage jsonb — what writes it (search updateSessionUsage / usage writes in src/lib/server/sessions/), why the sidebar Usage card shows zeros for live sessions, and what shape it has when populated.
4. Turn count source: how the page's runtime panel TURN value is derived (session.turn_started events? sessionWorkflowState?). Quote.
5. The GET /api/v1/sessions/[id]/goal response shape (we built it: status/tokensUsed/tokenBudget/iterations/maxIterations/timeUsedSeconds).
6. Model context-window limits: is there a model catalog with context sizes (model_catalog tables, src/lib/.../model-options.ts)? How could the UI know deepseek-v4-pro's context limit?`, { label: 'explore:data-sources', phase: 'Explore', schema: OUT, agentType: 'Explore' }),
  () => agent(`${COMMON}
TASK 2 — PAGE STRUCTURE + STREAM: How does the session detail page consume live events and where should a stats strip mount?
1. src/lib/stores/session-stream.svelte.ts — what the store exposes (events array? live append callback? snapshot?), how the page subscribes (onMount), and whether ALL event types (agent.llm_usage, agent.context_usage) flow through it or are filtered (preview mode? TRANSCRIPT_HIDDEN_TYPES?).
2. The page's existing derived metrics: the header chip showing '0 / 0' tokens (find fmtTokensCompact usage + what feeds it), the duration display, status indicators. Quote the relevant $derived blocks (~lines 100-900).
3. The header region layout (~line 1380-1460): structure of the title row + metadata row — where a horizontal stats strip would best mount (between header and Transcript tabs?). Quote the markup skeleton.
4. Does the page (or stream store) keep a full events array client-side that a stats component could reduce over (count llm_usage events, sum tokens)? Or are events paginated/preview-stripped (llm_usage data preserved in preview mode)?`, { label: 'explore:page-stream', phase: 'Explore', schema: OUT, agentType: 'Explore' }),
  () => agent(`${COMMON}
TASK 3 — UI PRIMITIVES + skaffold dev loop:
1. Available shadcn-svelte components in src/lib/components/ui/ (ls it): Progress? Tooltip? Card? Badge? Separator? Any chart/sparkline lib in package.json (layerchart? d3?)?
2. Existing 'awesome' visual patterns to match: look at src/lib/components/sessions/session-timeline-bar.svelte (how it's styled), event-type-pill.svelte color system, any radial/ring progress in the codebase (grep stroke-dasharray, conic-gradient, radial).
3. Design tokens: tailwind config accent colors, dark mode handling, the muted-foreground/primary palette used in the session page.
4. Skaffold inner loop for workflow-builder: confirm skaffold/workflow-builder.skaffold.yaml dev mode file-sync covers src/** (manifest sync rules), the dev pod entry (Dockerfile.dev, vite dev with HMR?), and what pnpm dev:skaffold does (scripts/skaffold-dev.sh) — including Argo pause/resume notes and the URL the dev pod serves on ryzen (same ingress?).`, { label: 'explore:ui-skaffold', phase: 'Explore', schema: OUT, agentType: 'Explore' }),
])

return results.filter(Boolean)
