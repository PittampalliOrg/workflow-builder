CREATE TABLE IF NOT EXISTS "capability_bundles" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_version_id" text,
	"created_by" text,
	"project_id" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_capability_bundles_slug" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "capability_bundle_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"bundle_id" text NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"changelog" text,
	"published_at" timestamp,
	"published_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_capability_bundle_version" UNIQUE("bundle_id","version")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "capability_bundles" ADD CONSTRAINT "capability_bundles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "capability_bundles" ADD CONSTRAINT "capability_bundles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "capability_bundle_versions" ADD CONSTRAINT "capability_bundle_versions_bundle_id_capability_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."capability_bundles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "capability_bundle_versions" ADD CONSTRAINT "capability_bundle_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_capability_bundles_project" ON "capability_bundles" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_capability_bundles_archived" ON "capability_bundles" ("is_archived");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_capability_bundle_versions_bundle" ON "capability_bundle_versions" ("bundle_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_capability_bundle_versions_hash" ON "capability_bundle_versions" ("config_hash");
