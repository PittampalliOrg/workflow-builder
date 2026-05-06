INSERT INTO "platforms" ("id", "name", "owner_id", "created_at", "updated_at")
VALUES ('default-platform', 'Default Platform', NULL, now(), now())
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
DELETE FROM "platform_oauth_apps" legacy
USING "platform_oauth_apps" canonical
WHERE legacy."platform_id" = 'default_platform'
  AND canonical."platform_id" = 'default-platform'
  AND canonical."piece_name" = legacy."piece_name";
--> statement-breakpoint
UPDATE "platform_oauth_apps"
SET "platform_id" = 'default-platform',
    "updated_at" = now()
WHERE "platform_id" = 'default_platform';
--> statement-breakpoint
UPDATE "users"
SET "platform_id" = 'default-platform',
    "updated_at" = now()
WHERE "platform_id" = 'default_platform';
--> statement-breakpoint
UPDATE "projects"
SET "platform_id" = 'default-platform',
    "updated_at" = now()
WHERE "platform_id" = 'default_platform';
--> statement-breakpoint
UPDATE "signing_keys"
SET "platform_id" = 'default-platform',
    "updated_at" = now()
WHERE "platform_id" = 'default_platform'
  AND NOT EXISTS (
    SELECT 1 FROM "signing_keys" WHERE "platform_id" = 'default-platform'
  );
--> statement-breakpoint
DELETE FROM "signing_keys"
WHERE "platform_id" = 'default_platform';
--> statement-breakpoint
DELETE FROM "platforms"
WHERE "id" = 'default_platform'
  AND NOT EXISTS (SELECT 1 FROM "users" WHERE "platform_id" = 'default_platform')
  AND NOT EXISTS (SELECT 1 FROM "projects" WHERE "platform_id" = 'default_platform')
  AND NOT EXISTS (SELECT 1 FROM "signing_keys" WHERE "platform_id" = 'default_platform')
  AND NOT EXISTS (SELECT 1 FROM "platform_oauth_apps" WHERE "platform_id" = 'default_platform');
