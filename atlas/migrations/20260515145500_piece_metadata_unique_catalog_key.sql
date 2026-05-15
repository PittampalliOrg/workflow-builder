UPDATE "piece_metadata" SET "platform_id" = 'OFFICIAL' WHERE "platform_id" IS NULL;

DELETE FROM "piece_metadata" pm
USING "piece_metadata" pm2
WHERE pm."name" = pm2."name"
  AND pm."version" = pm2."version"
  AND pm."platform_id" = pm2."platform_id"
  AND (
    pm."updated_at" < pm2."updated_at"
    OR (pm."updated_at" = pm2."updated_at" AND pm."id" < pm2."id")
  );

DROP INDEX IF EXISTS "idx_piece_metadata_name_platform_id_version";

CREATE UNIQUE INDEX IF NOT EXISTS "idx_piece_metadata_name_platform_id_version"
  ON "piece_metadata" ("name", "version", "platform_id");
