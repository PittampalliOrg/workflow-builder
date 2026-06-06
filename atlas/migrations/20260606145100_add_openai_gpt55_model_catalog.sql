-- Add GPT-5.5 to the enabled model catalog. GPT-5.5 is the current OpenAI
-- latest model slug in the official latest-model guide.
INSERT INTO "model_catalog" ("id", "provider_id", "model_key", "display_name", "sort_order") VALUES
  ('openai/gpt-5.5', 'openai', 'gpt-5.5', 'GPT-5.5', 5)
ON CONFLICT ("provider_id", "model_key") DO NOTHING;
