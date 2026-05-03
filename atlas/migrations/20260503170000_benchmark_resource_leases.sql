CREATE TABLE IF NOT EXISTS "benchmark_resource_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"instance_id" text,
	"phase" text DEFAULT 'inference' NOT NULL,
	"resource_type" text NOT NULL,
	"capacity_key" text DEFAULT 'default' NOT NULL,
	"holder_id" text NOT NULL,
	"lease_count" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acquired_at" timestamp DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"released_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "benchmark_resource_leases"
		ADD CONSTRAINT "benchmark_resource_leases_run_id_benchmark_runs_id_fk"
		FOREIGN KEY ("run_id") REFERENCES "public"."benchmark_runs"("id")
		ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "idx_benchmark_resource_leases_run"
	ON "benchmark_resource_leases" ("run_id");
CREATE INDEX IF NOT EXISTS "idx_benchmark_resource_leases_instance"
	ON "benchmark_resource_leases" ("run_id", "instance_id");
CREATE INDEX IF NOT EXISTS "idx_benchmark_resource_leases_resource"
	ON "benchmark_resource_leases" ("resource_type", "capacity_key", "status");
CREATE INDEX IF NOT EXISTS "idx_benchmark_resource_leases_holder"
	ON "benchmark_resource_leases" ("holder_id", "resource_type");
CREATE INDEX IF NOT EXISTS "idx_benchmark_resource_leases_expires"
	ON "benchmark_resource_leases" ("expires_at");

CREATE UNIQUE INDEX IF NOT EXISTS "uq_benchmark_resource_leases_active_holder"
	ON "benchmark_resource_leases" ("holder_id", "resource_type", "capacity_key")
	WHERE "status" = 'active';
