ALTER TABLE "agent_skill_registry"
	ADD COLUMN IF NOT EXISTS "registry_url" text,
	ADD COLUMN IF NOT EXISTS "install_source" text,
	ADD COLUMN IF NOT EXISTS "skill_name" text,
	ADD COLUMN IF NOT EXISTS "install_agent" text DEFAULT 'universal' NOT NULL;

UPDATE "agent_skill_registry"
SET
	"install_source" = COALESCE(
		NULLIF("install_source", ''),
		NULLIF(regexp_replace(COALESCE("source_repo", ''), '^https://github.com/', ''), ''),
		NULLIF(regexp_replace(COALESCE("source_repo", ''), '^https://skills.sh/', ''), '')
	),
	"skill_name" = COALESCE(NULLIF("skill_name", ''), NULLIF("name", ''), NULLIF("slug", '')),
	"registry_url" = COALESCE(
		NULLIF("registry_url", ''),
		CASE
			WHEN COALESCE("source_repo", '') LIKE 'https://skills.sh/%' THEN "source_repo"
			WHEN COALESCE("source_repo", '') <> '' THEN 'https://skills.sh/' || regexp_replace("source_repo", '^https://github.com/', '') || '/' || COALESCE(NULLIF("name", ''), "slug")
			ELSE NULL
		END
	),
	"source_type" = 'registry',
	"prompt" = '',
	"package_manifest" = NULL,
	"updated_at" = now()
WHERE "source_type" IN ('curated', 'imported', 'builtin', 'inline');

DELETE FROM "agent_skill_registry"
WHERE COALESCE("install_source", '') = ''
	OR COALESCE("skill_name", '') = ''
	OR "install_source" NOT LIKE '%/%'
	OR "install_source" = 'claude-code-src';
