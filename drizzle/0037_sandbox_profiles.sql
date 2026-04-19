-- Sandbox Profiles catalog: pre-built image catalog mapping slug → Dockerfile
-- → image tag. Admin UI edits the packages manifest, server regenerates the
-- Dockerfile, commits to stacks, and Tekton auto-rebuilds.
--
-- Addresses the runtime-install 403 / apt-root-required constraints in
-- OpenShell's client.exec path by moving deps to image build time (NVIDIA's
-- documented pattern).

CREATE TABLE IF NOT EXISTS "sandbox_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"base_profile_slug" text,
	"packages" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dockerfile_path" text,
	"image_tag" text,
	"last_build_sha" text,
	"last_build_at" timestamp,
	"last_build_status" text,
	"last_build_error" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"project_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_profiles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sandbox_profiles" ADD CONSTRAINT "sandbox_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sandbox_profiles" ADD CONSTRAINT "sandbox_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sandbox_profiles_archived" ON "sandbox_profiles" ("is_archived");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sandbox_profiles_project" ON "sandbox_profiles" ("project_id") WHERE "project_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sandbox_profiles_base" ON "sandbox_profiles" ("base_profile_slug");
