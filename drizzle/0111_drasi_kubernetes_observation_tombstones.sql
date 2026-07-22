-- Deleted observations remain in the append-heavy activity table as history,
-- but they must remove the corresponding node from Drasi's current-state CDC
-- projection so short-lived Pods, Sandboxes, Workloads, and Events stay bounded.
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

	IF TG_OP = 'UPDATE'
		AND OLD."source" = 'drasi-kubernetes-observer-current'
		AND (
			NEW."source" IS DISTINCT FROM 'drasi-kubernetes-observer-current'
			OR NEW."phase" = 'Deleted'
			OR NEW."event_id" IS DISTINCT FROM OLD."event_id"
		)
	THEN
		DELETE FROM "drasi_kubernetes_observations"
		WHERE "event_id" = OLD."event_id";
	END IF;

	IF NEW."source" = 'drasi-kubernetes-observer-current'
		AND NEW."phase" IS DISTINCT FROM 'Deleted'
	THEN
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
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DELETE FROM "drasi_kubernetes_observations"
WHERE "phase" = 'Deleted';
