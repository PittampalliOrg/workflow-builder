-- Phase 3a v2: add `mlflow_uri` column to `resource_prompt_versions` so a
-- prompt version's MLflow Prompt Registry URI is durable alongside its DB row.
--
-- The BFF's prompt-preset save path already fires `registerPromptInMlflow()`
-- (Phase 3a, commit 2b6f4367) which returns `{name, version, uri}`. Until now
-- we threw the URI away; this column captures it so traces can carry
-- `tag.prompt_version` and the UI can deep-link to MLflow's prompt browser.
--
-- Nullable because the column is back-filled lazily on the next save/edit:
-- existing rows stay null until their preset is touched again.

ALTER TABLE "resource_prompt_versions"
    ADD COLUMN IF NOT EXISTS "mlflow_uri" text NULL;

CREATE INDEX IF NOT EXISTS "idx_resource_prompt_versions_mlflow_uri"
    ON "resource_prompt_versions" ("mlflow_uri")
    WHERE "mlflow_uri" IS NOT NULL;
