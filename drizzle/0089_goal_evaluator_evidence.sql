-- Evaluator-gated goal completion (Phase 1: deterministic evidence gate).
-- See docs/goal-loop-evaluator-design.md. The doer agent's self-declared
-- completion (update_goal(complete) / native /goal) becomes a *request* for
-- evaluation: the BFF runs the goal's declared evidence commands in the session
-- workspace before marking it complete. Both columns are additive + nullable —
-- a goal WITHOUT evidence_plan.commands keeps the prior self-judged completion
-- behavior, so existing goals are unaffected (no backfill).
--   acceptance_criteria: human/agent-readable success criteria (labeling).
--   evidence_plan:       { commands: string[] } deterministic checks the
--                        evaluator runs in the workspace; all must exit 0.
ALTER TABLE "thread_goals" ADD COLUMN IF NOT EXISTS "acceptance_criteria" jsonb;
ALTER TABLE "thread_goals" ADD COLUMN IF NOT EXISTS "evidence_plan" jsonb;
