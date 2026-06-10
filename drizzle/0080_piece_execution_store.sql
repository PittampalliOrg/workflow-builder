CREATE TABLE IF NOT EXISTS "piece_execution" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"db_execution_id" text,
	"node_id" text NOT NULL,
	"piece_name" text NOT NULL,
	"action_name" text NOT NULL,
	"piece_version" text,
	"connection_external_id" text,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"result" jsonb,
	"error" text,
	"error_class" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "piece_store" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "piece_store_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_piece_execution_workflow" ON "piece_execution" ("workflow_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_piece_execution_db_execution" ON "piece_execution" ("db_execution_id");
