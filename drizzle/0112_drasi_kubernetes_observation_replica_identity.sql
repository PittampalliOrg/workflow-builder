-- Drasi 0.10's PostgreSQL reactivator materializes required columns for DELETE
-- events. Include the complete prior row in logical replication so projection
-- deletes do not terminate the CDC stream with null required fields.
ALTER TABLE "drasi_kubernetes_observations" REPLICA IDENTITY FULL;
