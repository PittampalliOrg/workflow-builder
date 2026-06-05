CREATE TABLE IF NOT EXISTS "gitops_activity_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"sequence" serial NOT NULL,
	"source" text NOT NULL,
	"activity_key" text NOT NULL,
	"activity_type" text NOT NULL,
	"phase" text,
	"reason" text,
	"message" text,
	"resource_group" text,
	"resource_version" text,
	"resource_resource" text,
	"resource_kind" text,
	"resource_namespace" text,
	"resource_name" text,
	"resource_uid" text,
	"observed_at" timestamp NOT NULL,
	"correlation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_gitops_activity_events_sequence" UNIQUE("sequence")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gitops_activity_events_activity_key" ON "gitops_activity_events" USING btree ("activity_key","observed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gitops_activity_events_resource" ON "gitops_activity_events" USING btree ("resource_kind","resource_namespace","resource_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gitops_activity_events_observed_at" ON "gitops_activity_events" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gitops_activity_events_source" ON "gitops_activity_events" USING btree ("source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gitops_activity_events_git_sha" ON "gitops_activity_events" USING btree ((correlation->>'gitSha')) WHERE correlation ? 'gitSha';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gitops_activity_events_image_name" ON "gitops_activity_events" USING btree ((correlation->>'imageName')) WHERE correlation ? 'imageName';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gitops_activity_events_pipeline_run" ON "gitops_activity_events" USING btree ((correlation->>'pipelineRun')) WHERE correlation ? 'pipelineRun';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gitops_activity_events_argocd_app" ON "gitops_activity_events" USING btree ((correlation->>'argocdApp')) WHERE correlation ? 'argocdApp';--> statement-breakpoint

CREATE OR REPLACE FUNCTION notify_gitops_activity_event()
RETURNS trigger AS $$
BEGIN
	PERFORM pg_notify(
		'gitops_activity_events',
		json_build_object(
			'eventId', NEW.event_id,
			'sequence', NEW.sequence,
			'observedAt', NEW.observed_at
		)::text
	);
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS gitops_activity_events_notify ON "gitops_activity_events";--> statement-breakpoint
CREATE TRIGGER gitops_activity_events_notify
AFTER INSERT ON "gitops_activity_events"
FOR EACH ROW
EXECUTE FUNCTION notify_gitops_activity_event();
