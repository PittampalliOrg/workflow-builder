ALTER TABLE "app_connection" DROP CONSTRAINT "app_connection_owner_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "idx_piece_metadata_name_platform_id_version";--> statement-breakpoint
UPDATE "piece_metadata" SET "platform_id" = 'OFFICIAL' WHERE "platform_id" IS NULL;--> statement-breakpoint
DELETE FROM "app_connection" WHERE "owner_id" IS NULL;--> statement-breakpoint
DELETE FROM "app_connection" ac
USING "app_connection" ac2
WHERE ac."owner_id" = ac2."owner_id"
  AND ac."external_id" = ac2."external_id"
  AND (
    ac."updated_at" < ac2."updated_at"
    OR (ac."updated_at" = ac2."updated_at" AND ac."id" < ac2."id")
  );--> statement-breakpoint
DELETE FROM "piece_metadata" pm
USING "piece_metadata" pm2
WHERE pm."name" = pm2."name"
  AND pm."version" = pm2."version"
  AND pm."platform_id" = pm2."platform_id"
  AND (
    pm."updated_at" < pm2."updated_at"
    OR (pm."updated_at" = pm2."updated_at" AND pm."id" < pm2."id")
  );--> statement-breakpoint
ALTER TABLE "app_connection" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "piece_metadata" ALTER COLUMN "platform_id" SET DEFAULT 'OFFICIAL';--> statement-breakpoint
ALTER TABLE "piece_metadata" ALTER COLUMN "platform_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app_connection" ADD CONSTRAINT "app_connection_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_app_connection_owner_external_id" ON "app_connection" USING btree ("owner_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_piece_metadata_name_platform_id_version" ON "piece_metadata" USING btree ("name","version","platform_id");
