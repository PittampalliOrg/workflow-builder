INSERT INTO "platforms" ("id", "name", "owner_id", "created_at", "updated_at")
VALUES ('default-platform', 'Default Platform', NULL, now(), now())
ON CONFLICT ("id") DO NOTHING;

DELETE FROM "platform_oauth_apps" legacy
USING "platform_oauth_apps" canonical
WHERE legacy."platform_id" = 'default_platform'
  AND canonical."platform_id" = 'default-platform'
  AND canonical."piece_name" = legacy."piece_name";

UPDATE "platform_oauth_apps"
SET "platform_id" = 'default-platform',
    "updated_at" = now()
WHERE "platform_id" = 'default_platform';

UPDATE "users"
SET "platform_id" = 'default-platform',
    "updated_at" = now()
WHERE "platform_id" = 'default_platform';

UPDATE "projects"
SET "platform_id" = 'default-platform',
    "updated_at" = now()
WHERE "platform_id" = 'default_platform';

UPDATE "signing_keys"
SET "platform_id" = 'default-platform',
    "updated_at" = now()
WHERE "platform_id" = 'default_platform'
  AND NOT EXISTS (
    SELECT 1 FROM "signing_keys" WHERE "platform_id" = 'default-platform'
  );

DELETE FROM "signing_keys"
WHERE "platform_id" = 'default_platform';

DELETE FROM "platforms"
WHERE "id" = 'default_platform'
  AND NOT EXISTS (SELECT 1 FROM "users" WHERE "platform_id" = 'default_platform')
  AND NOT EXISTS (SELECT 1 FROM "projects" WHERE "platform_id" = 'default_platform')
  AND NOT EXISTS (SELECT 1 FROM "signing_keys" WHERE "platform_id" = 'default_platform')
  AND NOT EXISTS (SELECT 1 FROM "platform_oauth_apps" WHERE "platform_id" = 'default_platform');
