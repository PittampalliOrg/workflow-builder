CREATE TABLE IF NOT EXISTS "code_functions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"version" text NOT NULL DEFAULT '0.1.0',
	"language" text NOT NULL,
	"entrypoint" text NOT NULL DEFAULT 'main',
	"path" text,
	"source" text NOT NULL,
	"supporting_files" jsonb,
	"source_hash" text NOT NULL,
	"semantic_model" jsonb,
	"input_schema" jsonb,
	"return_type" jsonb,
	"imports" jsonb,
	"diagnostics" jsonb,
	"capabilities" jsonb,
	"latest_published_version" text,
	"last_published_at" timestamp,
	"is_enabled" boolean NOT NULL DEFAULT true,
	"created_at" timestamp NOT NULL DEFAULT now(),
	"updated_at" timestamp NOT NULL DEFAULT now(),
	"created_by" text,
	CONSTRAINT "code_functions_slug_unique" UNIQUE("slug"),
	CONSTRAINT "code_functions_created_by_users_id_fk"
		FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "code_function_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"code_function_id" text NOT NULL,
	"version" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"language" text NOT NULL,
	"entrypoint" text NOT NULL DEFAULT 'main',
	"path" text,
	"source" text NOT NULL,
	"supporting_files" jsonb,
	"source_hash" text NOT NULL,
	"semantic_model" jsonb,
	"input_schema" jsonb,
	"return_type" jsonb,
	"imports" jsonb,
	"diagnostics" jsonb,
	"capabilities" jsonb,
	"published_at" timestamp NOT NULL DEFAULT now(),
	"created_by" text,
	CONSTRAINT "code_function_revisions_code_function_id_code_functions_id_fk"
		FOREIGN KEY ("code_function_id") REFERENCES "code_functions"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
	CONSTRAINT "code_function_revisions_created_by_users_id_fk"
		FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_code_function_revision_version"
	ON "code_function_revisions" ("code_function_id", "version");
