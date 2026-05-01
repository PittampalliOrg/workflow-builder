-- Versioned prompt preset payloads. The parent resource_prompts row remains
-- the workspace-owned discoverable preset; versions carry MCP-style messages,
-- arguments, template format, and audit hash.
CREATE TABLE IF NOT EXISTS "resource_prompt_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "prompt_id" text NOT NULL REFERENCES "resource_prompts"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "messages" jsonb NOT NULL,
  "arguments" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "template_format" text NOT NULL DEFAULT 'mustache',
  "template_hash" text NOT NULL,
  "metadata" jsonb,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_resource_prompt_versions_prompt_version"
  ON "resource_prompt_versions" ("prompt_id", "version");

CREATE INDEX IF NOT EXISTS "idx_resource_prompt_versions_prompt"
  ON "resource_prompt_versions" ("prompt_id");

CREATE INDEX IF NOT EXISTS "idx_resource_prompt_versions_template_hash"
  ON "resource_prompt_versions" ("template_hash");

INSERT INTO "resource_prompt_versions" (
  "id",
  "prompt_id",
  "version",
  "messages",
  "arguments",
  "template_format",
  "template_hash",
  "metadata",
  "created_by_user_id",
  "created_at"
)
SELECT
  'rpv_' || rp."id" || '_' || rp."version",
  rp."id",
  rp."version",
  CASE
    WHEN rp."user_prompt" IS NULL OR rp."user_prompt" = '' THEN
      jsonb_build_array(jsonb_build_object('role', 'system', 'content', rp."system_prompt"))
    ELSE
      jsonb_build_array(
        jsonb_build_object('role', 'system', 'content', rp."system_prompt"),
        jsonb_build_object('role', 'user', 'content', rp."user_prompt")
      )
  END,
  '[]'::jsonb,
  'mustache',
  md5(
    jsonb_build_object(
      'templateFormat', 'mustache',
      'systemPrompt', rp."system_prompt",
      'userPrompt', rp."user_prompt"
    )::text
  ),
  rp."metadata",
  rp."user_id",
  rp."created_at"
FROM "resource_prompts" rp
WHERE NOT EXISTS (
  SELECT 1
  FROM "resource_prompt_versions" rpv
  WHERE rpv."prompt_id" = rp."id"
    AND rpv."version" = rp."version"
);
