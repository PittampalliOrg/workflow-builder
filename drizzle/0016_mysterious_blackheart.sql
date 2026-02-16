CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"agent_type" text DEFAULT 'general' NOT NULL,
	"instructions" text NOT NULL,
	"model" jsonb NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_turns" integer DEFAULT 50 NOT NULL,
	"timeout_minutes" integer DEFAULT 30 NOT NULL,
	"default_options" jsonb,
	"memory_config" jsonb,
	"metadata" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agents_user_id" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_agents_project_id" ON "agents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_agents_agent_type" ON "agents" USING btree ("agent_type");