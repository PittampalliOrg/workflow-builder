ALTER TABLE "code_functions"
  ADD COLUMN "supporting_files" jsonb NULL,
  ADD COLUMN "latest_published_version" text NULL,
  ADD COLUMN "last_published_at" timestamp NULL;

CREATE TABLE "code_function_revisions" (
  "id" text PRIMARY KEY NOT NULL,
  "code_function_id" text NOT NULL,
  "version" text NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text NULL,
  "language" text NOT NULL,
  "entrypoint" text NOT NULL DEFAULT 'main',
  "path" text NULL,
  "source" text NOT NULL,
  "supporting_files" jsonb NULL,
  "source_hash" text NOT NULL,
  "semantic_model" jsonb NULL,
  "input_schema" jsonb NULL,
  "return_type" jsonb NULL,
  "imports" jsonb NULL,
  "diagnostics" jsonb NULL,
  "capabilities" jsonb NULL,
  "published_at" timestamp NOT NULL DEFAULT now(),
  "created_by" text NULL,
  CONSTRAINT "code_function_revisions_code_function_id_code_functions_id_fk"
    FOREIGN KEY ("code_function_id") REFERENCES "code_functions" ("id")
    ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "code_function_revisions_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users" ("id")
    ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE UNIQUE INDEX "uq_code_function_revision_version"
  ON "code_function_revisions" ("code_function_id", "version");
