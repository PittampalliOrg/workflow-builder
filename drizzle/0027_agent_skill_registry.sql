CREATE TABLE IF NOT EXISTS "agent_skill_registry" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"when_to_use" text,
	"prompt" text NOT NULL,
	"allowed_tools" jsonb,
	"arguments" jsonb,
	"argument_hint" text,
	"model" text,
	"user_invocable" boolean DEFAULT true NOT NULL,
	"disable_model_invocation" boolean DEFAULT false NOT NULL,
	"source_type" text DEFAULT 'curated' NOT NULL,
	"source_repo" text,
	"source_ref" text,
	"skill_path" text,
	"version" text DEFAULT '1' NOT NULL,
	"content_hash" text NOT NULL,
	"license" text,
	"compatibility" jsonb,
	"package_manifest" jsonb,
	"status" text DEFAULT 'ENABLED' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "agent_skill_registry" ADD CONSTRAINT "agent_skill_registry_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_skill_registry_slug_unique" ON "agent_skill_registry" USING btree ("slug");
CREATE INDEX IF NOT EXISTS "idx_agent_skill_registry_status" ON "agent_skill_registry" USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_agent_skill_registry_source" ON "agent_skill_registry" USING btree ("source_repo","skill_path");
