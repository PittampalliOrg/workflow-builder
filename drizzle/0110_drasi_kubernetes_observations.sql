-- Keep Drasi's Kubernetes CDC bootstrap bounded independently from the
-- append-heavy GitOps activity timeline. The timeline remains authoritative for
-- product history; this table is only the latest normalized row per resource.
CREATE TABLE IF NOT EXISTS "drasi_kubernetes_observations" (
	"event_id" text PRIMARY KEY NOT NULL,
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
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_drasi_kubernetes_observations_resource"
	ON "drasi_kubernetes_observations" (
		"resource_group", "resource_kind", "resource_namespace", "resource_name"
	);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_drasi_kubernetes_observations_phase"
	ON "drasi_kubernetes_observations" ("phase");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_drasi_kubernetes_observation()
RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD."source" = 'drasi-kubernetes-observer-current' THEN
			DELETE FROM "drasi_kubernetes_observations"
			WHERE "event_id" = OLD."event_id";
		END IF;
		RETURN OLD;
	END IF;

	IF NEW."source" = 'drasi-kubernetes-observer-current' THEN
		INSERT INTO "drasi_kubernetes_observations" (
			"event_id", "phase", "reason", "message", "resource_group",
			"resource_version", "resource_resource", "resource_kind",
			"resource_namespace", "resource_name", "resource_uid", "observed_at",
			"correlation", "updated_at"
		) VALUES (
			NEW."event_id", NEW."phase", NEW."reason", NEW."message",
			NEW."resource_group", NEW."resource_version", NEW."resource_resource",
			NEW."resource_kind", NEW."resource_namespace", NEW."resource_name",
			NEW."resource_uid", NEW."observed_at", NEW."correlation", NEW."updated_at"
		)
		ON CONFLICT ("event_id") DO UPDATE SET
			"phase" = EXCLUDED."phase",
			"reason" = EXCLUDED."reason",
			"message" = EXCLUDED."message",
			"resource_group" = EXCLUDED."resource_group",
			"resource_version" = EXCLUDED."resource_version",
			"resource_resource" = EXCLUDED."resource_resource",
			"resource_kind" = EXCLUDED."resource_kind",
			"resource_namespace" = EXCLUDED."resource_namespace",
			"resource_name" = EXCLUDED."resource_name",
			"resource_uid" = EXCLUDED."resource_uid",
			"observed_at" = EXCLUDED."observed_at",
			"correlation" = EXCLUDED."correlation",
			"updated_at" = EXCLUDED."updated_at"
		WHERE EXCLUDED."observed_at" >= "drasi_kubernetes_observations"."observed_at";
	ELSIF TG_OP = 'UPDATE' AND OLD."source" = 'drasi-kubernetes-observer-current' THEN
		DELETE FROM "drasi_kubernetes_observations"
		WHERE "event_id" = OLD."event_id";
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS gitops_activity_events_drasi_observation
	ON "gitops_activity_events";
--> statement-breakpoint
CREATE TRIGGER gitops_activity_events_drasi_observation
AFTER INSERT OR UPDATE OR DELETE ON "gitops_activity_events"
FOR EACH ROW EXECUTE FUNCTION sync_drasi_kubernetes_observation();
--> statement-breakpoint
-- Install the trigger before backfilling. CREATE TRIGGER's table lock is held
-- through the migration transaction, so a concurrent observer write cannot
-- fall between the snapshot and change capture.
INSERT INTO "drasi_kubernetes_observations" (
	"event_id", "phase", "reason", "message", "resource_group",
	"resource_version", "resource_resource", "resource_kind",
	"resource_namespace", "resource_name", "resource_uid", "observed_at",
	"correlation", "updated_at"
)
SELECT
	"event_id", "phase", "reason", "message", "resource_group",
	"resource_version", "resource_resource", "resource_kind",
	"resource_namespace", "resource_name", "resource_uid", "observed_at",
	"correlation", "updated_at"
FROM "gitops_activity_events"
WHERE "source" = 'drasi-kubernetes-observer-current'
ON CONFLICT ("event_id") DO UPDATE SET
	"phase" = EXCLUDED."phase",
	"reason" = EXCLUDED."reason",
	"message" = EXCLUDED."message",
	"resource_group" = EXCLUDED."resource_group",
	"resource_version" = EXCLUDED."resource_version",
	"resource_resource" = EXCLUDED."resource_resource",
	"resource_kind" = EXCLUDED."resource_kind",
	"resource_namespace" = EXCLUDED."resource_namespace",
	"resource_name" = EXCLUDED."resource_name",
	"resource_uid" = EXCLUDED."resource_uid",
	"observed_at" = EXCLUDED."observed_at",
	"correlation" = EXCLUDED."correlation",
	"updated_at" = EXCLUDED."updated_at"
WHERE EXCLUDED."observed_at" >= "drasi_kubernetes_observations"."observed_at";
