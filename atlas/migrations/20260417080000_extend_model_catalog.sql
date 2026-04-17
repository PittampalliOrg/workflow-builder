-- Add Anthropic models supported by workflow-orchestrator but absent from the
-- catalog: Opus 4.7 (now the default Opus in dapr-agent-py per commit 7f59211b)
-- and Haiku 4.5. Ships with ON CONFLICT DO NOTHING so it is safe to re-run.
INSERT INTO "model_catalog" ("id", "provider_id", "model_key", "display_name", "sort_order") VALUES
  ('anthropic/claude-opus-4-7', 'anthropic', 'claude-opus-4-7', 'Claude Opus 4.7', 5),
  ('anthropic/claude-haiku-4-5-20251001', 'anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 40)
ON CONFLICT ("provider_id", "model_key") DO NOTHING;
