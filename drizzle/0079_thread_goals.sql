CREATE TABLE IF NOT EXISTS "thread_goals" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"goal_id" text NOT NULL,
	"objective" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"token_budget" integer,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"time_used_seconds" integer DEFAULT 0 NOT NULL,
	"iterations" integer DEFAULT 0 NOT NULL,
	"max_iterations" integer DEFAULT 50 NOT NULL,
	"budget_steered_at" timestamp,
	"last_continuation_at" timestamp,
	"stop_reason" text,
	"workflow_execution_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "thread_goals" ADD CONSTRAINT "thread_goals_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_thread_goals_session_active" ON "thread_goals" ("session_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_thread_goals_session" ON "thread_goals" ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_thread_goals_status" ON "thread_goals" ("status");
