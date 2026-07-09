# Agent Teams — Phase 1 spec (parallel-worker teams on Dapr)

Status: DRAFT. Ports Claude Code "agent teams" (lead + peer teammates, shared claimable
task list, point-to-point mailbox, idle→notify-lead) onto the existing session substrate.
Grounded in the Dapr-native re-evaluation: we assemble Dapr's canonical building blocks
(workflow **external events** for delivery, a **Postgres** claimable list, a **reactive
coordinator**, the **Jobs API** for ticks) rather than adopting Dapr Agents' Pattern-B
turn-based orchestration (which is a debate/panel model and would bypass session_events,
Session Pulse, the Lifecycle Controller, and trace correlation).

## What already exists (reuse, do not rebuild)

- **Mailbox = workflow external events + dedup.** `appendSessionEvent()` +
  `raiseSessionUserEvents(sessionId, events)` → runtime `/internal/sessions/raise-event`
  → Dapr raise-event → `session_workflow` `wait_for_external_event("session.user_events")`.
  Exactly-once via a deterministic `sourceEventId` + the `(session_id, source_event_id)`
  partial unique index (Dapr external events are FIFO/buffered but do NOT dedup — this is
  the layer that fixes that). This is the goal-continuation path; teammate messages reuse it.
- **Peer spawn.** `spawnPeerSession(body)` + the `call_agent` tool + `callableAgents[]`
  (`{slug, agentId, appId, team, registryKey}`) + `sessions.parentSessionId/parentExecutionId`.
- **Atomic claim template.** `GoalLoopStore.claimNextContinuation()` — a single guarded
  `UPDATE … WHERE … RETURNING`. `claim_task` copies this pattern.
- **Reactive driver.** `goal-loop.ts:onSessionEvent()` wired through
  `application/adapters/session-events.ts`; reacts to `session.status_idle` / `agent.llm_usage`.
- **Lifecycle.** `stopDurableRun(target,{mode})` — teammate shutdown MUST route through it
  (per-session task-hub wedge; never external Dapr terminate).
- **Infra.** `workflowstatestore` (one actorStateStore), NATS JetStream pub/sub deployed,
  Kueue-admitted per-session Sandbox pods. Everything in the `workflow-builder` namespace
  (Dapr child workflows are same-namespace only).

## The two refinements folded in

1. **Driver ticks via Dapr Jobs API, not a K8s CronJob.** The lost-idle safety net for the
   team driver (and, opportunistically, the existing `goal-loop-tick`) becomes a Dapr Job:
   a cron/interval callback into the BFF, at-least-once, single-trigger across replicas,
   sharing the Scheduler control plane that already backs workflow timers + actor reminders.
   Happy path stays event-driven; the Job is only the lost-idle backstop.
2. **Messaging split by cardinality.** `send_message(to=X)` = point-to-point **external
   event** (recipient is a live `session_workflow` already awaiting them). `broadcast()` =
   fan-out over **NATS JetStream** (the one idea grafted from Pattern-B's `broadcast_topic`).

## Data model — migration `drizzle/00NN_agent_teams.sql`

Hand-authored, additive + idempotent, matching the `0097` style (IF NOT EXISTS + `DO $$`
duplicate_object guards). Team messages reuse `session_events` (no new table).

```sql
-- Agent Teams (Phase 1): lead + peer teammates, shared claimable task list.
-- Messages reuse session_events (type=user.message, origin=teammate-message|team-broadcast).

CREATE TABLE IF NOT EXISTS "teams" (
  "id" text PRIMARY KEY NOT NULL,
  "workflow_execution_id" text,               -- null for a lead-session-scoped team
  "project_id" text NOT NULL,
  "name" text NOT NULL,
  "lead_session_id" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,     -- active | disbanded
  "token_budget" integer,                      -- optional team-wide soft cap
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "team_members" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL,
  "session_id" text NOT NULL,
  "agent_slug" text,
  "name" text NOT NULL,                         -- addressable within the team
  "role" text DEFAULT 'member' NOT NULL,        -- lead | member
  "model" text,
  "status" text DEFAULT 'working' NOT NULL,     -- working | idle | failed | shutdown
  "plan_mode_required" boolean DEFAULT false NOT NULL,
  "joined_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "team_members_team_id_name_uq" UNIQUE ("team_id","name"),
  CONSTRAINT "team_members_session_uq" UNIQUE ("session_id")
);

CREATE TABLE IF NOT EXISTS "team_tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'pending' NOT NULL,     -- pending | in_progress | completed
  "assignee_session_id" text,
  "depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by_session_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp
);

CREATE INDEX IF NOT EXISTS "team_members_team_idx" ON "team_members" ("team_id");
CREATE INDEX IF NOT EXISTS "team_tasks_team_status_idx" ON "team_tasks" ("team_id","status");

DO $$ BEGIN
  ALTER TABLE "teams" ADD CONSTRAINT "teams_workflow_execution_id_fk"
    FOREIGN KEY ("workflow_execution_id") REFERENCES "workflow_executions"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fk"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "team_tasks" ADD CONSTRAINT "team_tasks_team_id_fk"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
```

## The atomic claim (the load-bearing race guard)

Race-safe, dependency-aware, no double-claim — the SQL turn lock replaces an actor lock while
staying queryable. `FOR UPDATE SKIP LOCKED` lets N idle teammates claim concurrently without
contention.

```sql
UPDATE team_tasks SET status='in_progress', assignee_session_id=$2, updated_at=now()
WHERE id = (
  SELECT t.id FROM team_tasks t
  WHERE t.team_id=$1 AND t.status='pending' AND t.assignee_session_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(t.depends_on) dep
      JOIN team_tasks d ON d.id = dep WHERE d.status <> 'completed')
  ORDER BY t.created_at FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;
```

## MCP surface — `services/workflow-mcp-server/src/team-tools.ts`

Mirror `goal-tools.ts` exactly (registerTool + zod inputSchema + `textResult`/`errorResult`).
Session id via `currentGoalSessionId()` (already wired); add `team-context.ts` (an ALS clone
of `goal-context.ts`) resolving `X-Wfb-Team-Id`, and an `X-Wfb-Team-Depth` nesting guard
(teammates cannot spawn teams — mirror `suppressScriptTools`). Register in `createMcpServer`
alongside `registerGoalTools`, gated so team tools are suppressed when `X-Wfb-Team-Depth` is set.

Tools:
- `spawn_teammate({agentSlug, name, prompt, model?, planModeRequired?})` → BFF
  `POST /api/internal/team/{teamId}/spawn` (wraps `spawnPeerSession` + `team_members` insert).
- `list_teammates()` → `team-db.listMembers` (name, role, status, model).
- `send_message({to, content})` → BFF `POST /api/internal/team/{teamId}/message`.
- `broadcast({content})` → BFF `POST /api/internal/team/{teamId}/broadcast` (NATS fan-out).
- `create_task({title, description?, dependsOn?, assignee?})` → `team-db.createTask`.
- `claim_task()` → BFF `POST /api/internal/team/{teamId}/claim`, which calls the ONE
  canonical `claimNextTask()` in `src/lib/server/teams/team-tasks.ts` (single source of the
  claim SQL, PGlite-unit-tested in `team-tasks.test.ts`). Same "tool → internal endpoint"
  shape `update_goal` uses for `/evaluate`; costs one internal hop, buys testability + one
  place to change the claim logic.
- `update_task({taskId, status})` → `completeTask()` (emits `task.completed`).
- `shutdown_teammate({name})` → BFF `POST /api/internal/team/{teamId}/shutdown`
  (`stopDurableRun` cooperative — NEVER external terminate).

`team-db.ts` = direct pg (`getPool()`, `nanoid()` ids) like `goal-db.ts`.

## BFF internal endpoints — `src/routes/api/internal/team/[teamId]/*`

- `spawn` → `spawnPeerSession({peerAgentId, prompt, parentSessionId, ...})`, insert
  `team_members`, return `{sessionId, name}`.
- `message` → `appendSessionEvent(recipientSessionId, {type:"user.message",
  data:{origin:"teammate-message", fromAgent:<name>, content:[{type:"text",text}]},
  sourceEventId:"team-msg:"+msgId})` then `raiseSessionUserEvents`.
- `broadcast` → publish to NATS; each member also gets a `team-broadcast` injected message.
- `shutdown` → resolve member session → `stopDurableRun({kind:"session",id},{mode:"terminate"})`.

All idempotent; every injected event carries a deterministic `sourceEventId`.

## Coordinator — `src/lib/server/teams/team-driver.ts`

Reactive, modeled on `goal-loop.ts:onSessionEvent`; wire into `session-events.ts`:
- teammate `session.status_idle(end_turn)` → mark member `idle`; inject an idle-notice
  `user.message` into the **lead** (`sourceEventId:"team-idle:"+sid+":"+seq`); if auto-claim
  is on, run the atomic claim and, on a hit, inject the task into that teammate.
- `task.completed` → dependents unblock automatically (claim query re-checks deps); optionally
  nudge idle teammates.
- **Ticks:** a Dapr Job (`team-driver-tick`) calls a BFF route to re-probe lost idles. Do NOT
  add a K8s CronJob.

## Non-negotiable constraints (feed these to the evaluator)

- Reuse `session_events` + `raiseSessionUserEvents` for delivery; do not add a second bus for
  point-to-point. Every injected event needs a deterministic `sourceEventId`.
- Teammate shutdown routes through `stopDurableRun`; never external Dapr terminate.
- Do not create per-session/per-team actor state stores; one `workflowstatestore`.
- The team driver is out-of-band (reactive hook + Dapr Job) — never inside a workflow body.
- Do not regress the goal loop, dynamic-script engine, or lifecycle controller.
- Everything in the `workflow-builder` namespace.

## Remaining wiring (the one integration piece + its design fork)

Everything above is built and typechecks. The last piece — needed for E/F to work
end-to-end — is the **spawn-time MCP wiring**: a teammate's `agentConfig` must carry the
team tools' scope. The team tools live on the SAME `workflow-mcp-server` that already hosts
goal/script tools (so `ensureGoalMcpServer` already adds the entry); we only need to stamp,
on that entry, `X-Wfb-Team-Id` (both lead and teammates) and `X-Wfb-Team-Depth: 1`
(teammates only), mirroring `stampGoalMcpSessionHeader` / `stampScriptGuardHeader` in
`src/lib/server/goals/mcp-wiring.ts`.

**Design fork to settle with a live test (do NOT bake in blind):** how does the *lead* get a
`X-Wfb-Team-Id` before it has formed a team?
- **Option A — derived id (Claude-Code-style):** every session is a potential lead with
  `teamId = team-<sessionId>`; stamp it on every session; `ensureTeam` creates the row
  lazily on first `spawn_teammate`. Simple, but requires **dropping the `team_tasks→teams`
  FK** (or lazily ensuring the team on `create_task`) so a task can be created before the
  team row exists. In `spawn.ts`, look up `team_members` by session id to detect teammates
  (stamp depth) vs leads (no depth); insert the teammate's member row **before**
  `spawnPeerSession` so the lookup resolves.
- **Option B — explicit formation:** a `form_team` step creates the team + stamps the lead's
  MCP entry via a session update / re-spawn. Keeps the FK, adds a step.

Recommendation: **Option A** (matches the lightweight session-scoped team model), which means
one migration tweak (drop the two `team_tasks`/`team_members`→`teams` FKs, keep the indexes)
and the `stampTeamMcpHeaders` helper + `spawn.ts` hook. Settle it against the dev cluster
(checks E/F) rather than guessing the FK/ordering semantics offline.

## Deployment (learnings)

The dev cluster is **GitOps-fed via `PittampalliOrg/stacks:main`** — the Skaffold inner-loop
is **ryzen-only**, not dev. Deploy Phase 1 by: build + push `workflow-mcp-server` and
`workflow-builder` images to `ghcr.io/pittampalliorg`, pin the new tags in stacks:main, and
let ArgoCD (`dev-workflow-builder`) reconcile onto dev. Set `TEAM_MCP_AUTO_WIRE=true` on the
dev `workflow-builder` Deployment env so a lead session receives the team tools (teammates are
always stamped). Run SQL / apply migrations via
`kubectl --context dev -n workflow-builder exec postgresql-0 -- psql`. `scripts/verify-agent-teams-dev.sh`
uses `--context dev`.

## Acceptance (Phase 1 done when)

1. Migration applies; `teams`/`team_members`/`team_tasks` exist.
2. `pnpm check`/typecheck + lint clean for the new TS.
3. A unit test proves the atomic claim: two concurrent `claim_task` calls never double-assign,
   and a task with an unmet dependency is not claimable.
4. team-tools registered and visible on the MCP surface (suppressed under `X-Wfb-Team-Depth`).
5. Deployed to the dev cluster (Skaffold) with all pods Ready (no 1/2 daprd).
6. End-to-end on dev: a lead session spawns a teammate, `create_task`, the teammate
   `claim_task` + `update_task(completed)`, the lead receives the idle/completion notice —
   verified via SQL (`team_tasks.status='completed'`), `session_events` (the injected
   messages with their `sourceEventId`), and orchestrator/runtime logs.
```
