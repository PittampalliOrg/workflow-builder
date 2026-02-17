-- Create "model_providers" table
CREATE TABLE "model_providers" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "icon_key" text NOT NULL,
  "description" text NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_model_providers_name" UNIQUE ("name")
);
-- Create index "idx_model_providers_enabled" to table: "model_providers"
CREATE INDEX "idx_model_providers_enabled" ON "model_providers" ("is_enabled");
-- Create index "idx_model_providers_sort_order" to table: "model_providers"
CREATE INDEX "idx_model_providers_sort_order" ON "model_providers" ("sort_order");
-- Create "model_catalog" table
CREATE TABLE "model_catalog" (
  "id" text NOT NULL,
  "provider_id" text NOT NULL,
  "model_key" text NOT NULL,
  "display_name" text NOT NULL,
  "description" text NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "metadata" jsonb NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_model_catalog_provider_model" UNIQUE ("provider_id", "model_key"),
  CONSTRAINT "model_catalog_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "model_providers" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_model_catalog_enabled" to table: "model_catalog"
CREATE INDEX "idx_model_catalog_enabled" ON "model_catalog" ("is_enabled");
-- Create index "idx_model_catalog_provider_sort" to table: "model_catalog"
CREATE INDEX "idx_model_catalog_provider_sort" ON "model_catalog" ("provider_id", "sort_order");
-- Seed default model providers
INSERT INTO "model_providers" ("id", "name", "icon_key", "sort_order") VALUES
  ('openai', 'OpenAI', 'openai', 10),
  ('anthropic', 'Anthropic', 'anthropic', 20),
  ('google', 'Google', 'google', 30),
  ('meta', 'Meta', 'meta', 40);
-- Seed default model catalog entries
INSERT INTO "model_catalog" ("id", "provider_id", "model_key", "display_name", "sort_order") VALUES
  ('openai/gpt-5.3-codex', 'openai', 'gpt-5.3-codex', 'GPT-5.3 Codex', 10),
  ('openai/gpt-5.2-codex', 'openai', 'gpt-5.2-codex', 'GPT-5.2 Codex', 20),
  ('openai/gpt-5.1-instant', 'openai', 'gpt-5.1-instant', 'GPT-5.1 Instant', 30),
  ('openai/gpt-4o', 'openai', 'gpt-4o', 'GPT-4o', 40),
  ('openai/gpt-4o-mini', 'openai', 'gpt-4o-mini', 'GPT-4o mini', 50),
  ('anthropic/claude-opus-4-6', 'anthropic', 'claude-opus-4-6', 'Claude Opus 4.6', 10),
  ('anthropic/claude-sonnet-4-6', 'anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', 20),
  ('anthropic/claude-sonnet-4-5', 'anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5', 30),
  ('google/gemini-2.5-pro', 'google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 10),
  ('google/gemini-2.5-flash', 'google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 20);
