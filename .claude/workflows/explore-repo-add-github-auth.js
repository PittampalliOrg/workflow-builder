export const meta = {
  name: 'explore-repo-add-github-auth',
  description: 'Map how repos are added to interactive sessions/agents and how GitHub auth is (supposed to be) wired, in app code and on the dev cluster/previews',
  phases: [{ title: 'Explore', detail: 'app code path + cluster/secret plumbing in parallel' }],
}

const APP_SCHEMA = {
  type: 'object',
  required: ['repo_add_flow', 'auth_model', 'sandbox_clone_mechanics', 'missing_config_symptom', 'preview_specifics', 'report'],
  properties: {
    repo_add_flow: { type: 'string', description: 'end-to-end: where in the UI a user adds a repo to a session/agent, which BFF endpoint/remote fn handles it, what gets stored (DB tables), and how it reaches the SEA/sandbox' },
    auth_model: { type: 'string', description: 'how GitHub auth is designed to work: per-user OAuth token (which OAuth app / scopes), GitHub App installation, PAT, env GITHUB_TOKEN, gh auth in the sandbox image — with file:line evidence; where tokens are stored and how they are injected into clones/pushes' },
    sandbox_clone_mechanics: { type: 'string', description: 'who performs the git clone (init container? runtime script? CLI agent itself?), with what credential material, for interactive-cli AND interactive-agent AND dev-preview classes' },
    missing_config_symptom: { type: 'string', description: 'what exactly fails/looks unconfigured when github auth is absent (UI state, error, fallback to public-only?) — match the user report "I can add a repo but my github auth is not configured"' },
    preview_specifics: { type: 'string', description: 'how this flow differs inside a preview vcluster (what the BFF/SEA there would need; what claim-time cred copying already exists e.g. CLI creds)' },
    report: { type: 'string', description: 'full findings with file:line citations' },
  },
}

const INFRA_SCHEMA = {
  type: 'object',
  required: ['dev_secret_flow', 'live_state', 'preview_secret_flow', 'gaps', 'report'],
  properties: {
    dev_secret_flow: { type: 'string', description: 'how GITHUB_*/OAUTH_APP_GITHUB_* and any repo-access tokens flow to the dev BFF/SEA today: ExternalSecrets, KV keys (names), render-script oauth ops, envFrom wiring' },
    live_state: { type: 'string', description: 'READ-ONLY live evidence from dev: which github-related keys exist in workflow-builder secrets (key NAMES only, never values), which are empty/missing, what the BFF deployment consumes' },
    preview_secret_flow: { type: 'string', description: 'what secrets/creds a preview vcluster gets today (app-overlay is ESO-free): what runner.sh copies at bake/claim (CLI creds etc), whether github oauth/token material is among them' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'concrete missing pieces for (a) dev cluster github auth and (b) pre-provisioned previews' },
    report: { type: 'string', description: 'full findings with file:line + live citations' },
  },
}

const [app, infra] = await parallel([
  () => agent(`READ-ONLY exploration of /home/vpittamp/repos/PittampalliOrg/workflow-builder/main (SvelteKit BFF at src/, sandbox-execution-api at services/sandbox-execution-api/, sandbox images under skaffold/ + docker/ + services/). Do not modify anything.

GOAL: The workflow-builder app lets a user ADD A REPOSITORY to interactive sessions and agents (CLI agents: claude/codex/agy in cli-agent-py-sandbox; also interactive-agent and dev-preview classes). The user reports: "I can add a repo, but my github auth is not configured." Map the ENTIRE repo-add + GitHub-auth design so we can provision auth on the dev cluster and pre-provision previews.

INVESTIGATE (cite file:line):
1. UI + BFF: find the add-repo surface (search: 'add repo', 'repository', 'repoUrl', 'gitUrl', 'clone', 'github' under src/routes and src/lib). Which remote functions/endpoints handle it, what's persisted (drizzle schema tables — search src/lib/server/db/schema* for repo/github/token tables), per-user vs per-agent vs per-session scoping.
2. GitHub AUTH design: search for OAUTH_APP_GITHUB, GITHUB_TOKEN, GH_TOKEN, installation, octokit, personal access, device flow, 'gh auth', credential helper. Distinguish (a) the login OAuth (GITHUB_CLIENT_ID/SECRET) from (b) any repo-access auth (OAUTH_APP_GITHUB_CLIENT_ID/SECRET or GitHub App). Where does a user connect GitHub (settings page? /connections?), what scopes are requested, where is the token stored (DB table? encrypted?), how is it refreshed, and HOW IS IT USED for git operations (x-access-token clone URLs? credential injection into the sandbox?).
3. Sandbox clone mechanics: in services/sandbox-execution-api/src/app.py find how repos reach the pod for interactive-cli / interactive-agent / dev-preview (search: clone, repo, GIT_, workspace, WORKSPACE, repos param in DevPreviewRequest/session start payloads). Who clones (init container? entry script in the sandbox image — check skaffold/ + the cli-agent-py sandbox Dockerfile/entrypoint + services/*agent*/), and with what credential env/mounts.
4. The unconfigured symptom: find the code path that decides github auth is 'not configured' (UI banner? API error? empty env check like OAUTH_APP_GITHUB_CLIENT_ID missing?). What EXACT config keys does the BFF need for the connect-github flow to work?
5. Previews: does the session/repo-add flow inside a preview vcluster differ (env the preview BFF lacks, callbacks/redirect URLs that must point at the preview host, token tables in the per-preview DB clone)?

Return structured output; exhaustive 'report' with file:line.`, { label: 'explore:app-auth-flow', phase: 'Explore', schema: APP_SCHEMA, agentType: 'Explore' }),

  () => agent(`READ-ONLY exploration of /home/vpittamp/repos/PittampalliOrg/stacks/main plus READ-ONLY kubectl against the dev cluster (kubectl --context dev …, get/describe only; NEVER print secret VALUES — key names only, e.g. -o jsonpath='{.data}' piped through a keys-only jq/awk). Hub read-only access if needed: kubectl --context hub-cluster. Do not modify anything. Do NOT touch vcluster-pool-5953 / vcluster-pool-2576 workloads beyond listing/reading specs.

GOAL: workflow-builder users add repos to interactive sessions/agents; GitHub auth for that is unconfigured on dev. Map how GitHub-related secrets flow (or fail to flow) to the dev BFF/SEA and what previews get, so we can provision dev + pre-provision the vcluster preview pool.

INVESTIGATE (cite file:line / live object names):
1. Stacks secret plumbing: in packages/components/workloads/workflow-builder/ find the ExternalSecret(s) feeding the BFF (workflow-builder-secrets etc). List ALL github-related data keys they map (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, OAUTH_APP_GITHUB_CLIENT_ID/SECRET, GITHUB_TOKEN, GH_*, GITHUB_APP_*). Cross-ref scripts/gitops/render-workflow-builder-release-overlays.sh's emit_oauth_op section (which KV keys per cluster, e.g. OAUTH-APP-GITHUB-CLIENT-ID-DEV). Note which keys the render targets vs which exist in the base ES.
2. LIVE dev state: kubectl --context dev -n workflow-builder — get the BFF Deployment env/envFrom; get the relevant Secret(s) and list KEY NAMES ONLY (jsonpath {.data} | keys). Which github keys are present, and is there any sign OAUTH_APP_GITHUB_* / GITHUB_TOKEN style keys are missing or empty-length? (You may report base64 LENGTH of values as emptiness signal, never decode.) Check the ExternalSecret status (synced? which remoteRefs error?).
3. Source of truth: where do these KV values live (hub Azure KV via AWI? hub dev-shared-secrets mirror secret via hub-secrets-store per the ESO-over-Tailscale recipe)? On the HUB: list key NAMES in dev-shared-secrets (ns?) to see whether OAUTH-APP-GITHUB-*-DEV / any GITHUB TOKEN keys exist there.
4. Preview vcluster secret path: packages/components/workloads/workflow-builder-preview-vcluster/ — app-overlay is ESO-FREE; find how the preview BFF gets ITS secrets (runner.sh: search for secret, creds, copy, kubectl create secret, cli creds; vcluster.yaml sync rules). What exactly is copied at bake vs claim today (the claim() 'copy CLI creds' step — which secret names)? Is any github oauth/token material included?
5. Also check: any existing GitHub App / installation-token infra in stacks (github-clone-credentials in tekton, ghcr-push-credentials) that could be reused as a pattern; and how the preview BFF's OAuth callback/host differs (tailnet host wfb-<alias>) if relevant to a github connect flow.

List concrete 'gaps' for (a) dev github auth, (b) pre-provisioned previews. Return structured output; exhaustive 'report'.`, { label: 'explore:secret-plumbing', phase: 'Explore', schema: INFRA_SCHEMA, agentType: 'Explore' }),
])

return { app, infra }