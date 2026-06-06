-- Add Claude Opus 4.8 to the enabled model catalog. Older Opus aliases
-- canonicalize to this model in the application model selector.
INSERT INTO "model_catalog" ("id", "provider_id", "model_key", "display_name", "sort_order") VALUES
  ('anthropic/claude-opus-4-8', 'anthropic', 'claude-opus-4-8', 'Claude Opus 4.8', 4)
ON CONFLICT ("provider_id", "model_key") DO NOTHING;
