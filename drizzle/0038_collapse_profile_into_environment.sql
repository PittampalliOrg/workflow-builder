-- Collapse Sandbox Profile + Environment into a single primitive.
--
-- Before: agent → environment → (config.sandboxTemplate) → sandbox_profile → image
-- After:  agent → environment (packages + imageTag inlined on environment_versions)
--
-- CMA-shape. Drops the Profile layer that accrued historically because we
-- introduced baked-image support after the CMA-parity env work. 99% of envs
-- are 1:1 with a profile, making the indirection pure ceremony.
--
-- Migration:
-- 1. Add build-artifact columns to environment_versions.
-- 2. Add isBuiltin + baseEnvSlug to environments.
-- 3. For each sandbox_profiles row, upsert an environments row and fresh
--    environment_version carrying its packages + capabilities + imageTag.
-- 4. Rebind agents that pointed at a redundant wrapper env (env_default_sandbox,
--    env_manim_animation) directly at the corresponding builtin env.
-- 5. Delete the redundant wrapper envs.
-- 6. sandbox_profiles table kept for rollback — dropped in a follow-up migration
--    once the code changes are stable.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Schema changes
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE environment_versions
	ADD COLUMN IF NOT EXISTS image_tag         text,
	ADD COLUMN IF NOT EXISTS dockerfile_path   text,
	ADD COLUMN IF NOT EXISTS last_build_sha    text,
	ADD COLUMN IF NOT EXISTS last_build_at     timestamp,
	ADD COLUMN IF NOT EXISTS last_build_status text,
	ADD COLUMN IF NOT EXISTS last_build_error  text;

ALTER TABLE environments
	ADD COLUMN IF NOT EXISTS is_builtin    boolean NOT NULL DEFAULT false,
	ADD COLUMN IF NOT EXISTS base_env_slug text;

CREATE INDEX IF NOT EXISTS idx_environments_builtin ON environments (is_builtin);
CREATE INDEX IF NOT EXISTS idx_environments_base    ON environments (base_env_slug);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Upsert environments rows from sandbox_profiles.
--    Builtins are workspace-agnostic (project_id NULL).
-- ─────────────────────────────────────────────────────────────────────────

INSERT INTO environments (id, slug, name, description, tags, runtime, project_id, created_by, is_builtin, base_env_slug, created_at, updated_at)
SELECT
	'env_builtin_' || replace(slug, '-', '_'),
	slug,
	name,
	description,
	'["builtin"]'::jsonb,
	'cloud',
	NULL,
	created_by,
	is_builtin,
	-- base_env_slug null for root, else inherits from base_profile_slug
	base_profile_slug,
	created_at,
	updated_at
FROM sandbox_profiles
ON CONFLICT (slug) DO UPDATE SET
	is_builtin = excluded.is_builtin,
	base_env_slug = excluded.base_env_slug,
	updated_at = now();

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Emit a fresh environment_version per builtin profile with packages +
--    capabilities + build artifacts inlined. Config hash computed offline
--    (canonical JSON per canonicalJson in src/lib/server/agents/config-hash.ts).
-- ─────────────────────────────────────────────────────────────────────────

INSERT INTO environment_versions
	(id, environment_id, version, config, config_hash,
	 image_tag, dockerfile_path, last_build_sha, last_build_at, last_build_status, last_build_error,
	 published_at, created_at)
SELECT
	'envv_builtin_' || replace(sp.slug, '-', '_') || '_v1',
	e.id,
	COALESCE((SELECT MAX(version) + 1 FROM environment_versions WHERE environment_id = e.id), 1),
	jsonb_build_object(
		'sandboxMode',   'per-run',
		'keepAfterRun',  false,
		'ttlSeconds',    7200,
		'networking',    jsonb_build_object('type', 'unrestricted'),
		'packages',      sp.packages,
		'capabilities',  sp.capabilities,
		'metadata',      '{}'::jsonb
	),
	CASE sp.slug
		WHEN 'dapr-agent'           THEN '069417d5fc9895319df03f2f6642c67e4242bee0bb47644d0ac58ab1d2c5b529'
		WHEN 'dapr-agent-xlsx'      THEN '5643bd853fec63aba05ffc7f2af312b46cc2143ba02ac025301aae9fb36557db'
		WHEN 'dapr-agent-animation' THEN '6c69bb8fc8e16ec5bd7b86a99f1dffd196e4a40d446f947800f9af1d9cf3eceb'
		WHEN 'dapr-agent-datasci'   THEN '065fe10b37f2711dadf959258a5e2f1bfa0608762730eebef2c95ed742523a29'
		WHEN 'dapr-agent-webdev'    THEN 'c1c168396171ec980e34a1b802cb8abc619443d364f1285bb25459d6a9ceed37'
		ELSE md5(sp.packages::text)
	END,
	sp.image_tag,
	sp.dockerfile_path,
	sp.last_build_sha,
	sp.last_build_at,
	sp.last_build_status,
	sp.last_build_error,
	now(),
	now()
FROM sandbox_profiles sp
JOIN environments e ON e.slug = sp.slug
ON CONFLICT (id) DO NOTHING;

-- 4. Point environments.current_version_id at the freshly emitted version.
UPDATE environments e
SET current_version_id = (
	SELECT id FROM environment_versions
	WHERE environment_id = e.id
	ORDER BY version DESC
	LIMIT 1
), updated_at = now()
WHERE slug IN (SELECT slug FROM sandbox_profiles);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Rebind agents away from the redundant wrapper envs onto the builtin envs.
--    env_manim_animation → dapr-agent-animation (1 agent)
--    env_default_sandbox → dapr-agent            (49 agents)
-- ─────────────────────────────────────────────────────────────────────────

UPDATE agents
SET environment_id = (SELECT id FROM environments WHERE slug = 'dapr-agent-animation'),
    environment_version = 1,
    updated_at = now()
WHERE environment_id = 'env_manim_animation';

UPDATE agents
SET environment_id = (SELECT id FROM environments WHERE slug = 'dapr-agent'),
    environment_version = 1,
    updated_at = now()
WHERE environment_id = 'env_default_sandbox';

-- Belt-and-suspenders: archive the redundant envs rather than hard-delete,
-- so any external reference still resolves to a row (just archived) until
-- the rollout stabilizes. Follow-up migration will physically delete.
UPDATE environments
SET is_archived = true, updated_at = now()
WHERE id IN ('env_manim_animation', 'env_default_sandbox');

-- ─────────────────────────────────────────────────────────────────────────
-- 6. sandbox_profiles table retained for rollback; dropped in a follow-up
--    after the code changes stabilize.
-- ─────────────────────────────────────────────────────────────────────────

COMMIT;

-- Verification queries (run outside the transaction):
-- SELECT e.slug, e.is_builtin, ev.version, ev.image_tag, ev.last_build_status
-- FROM environments e LEFT JOIN environment_versions ev ON ev.id = e.current_version_id
-- ORDER BY e.is_builtin DESC, e.slug;
--
-- SELECT environment_id, count(*) FROM agents WHERE environment_id IS NOT NULL GROUP BY 1;
