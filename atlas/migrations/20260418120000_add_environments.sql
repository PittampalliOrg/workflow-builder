-- Phase 1 of the CMA-mirror refactor: promote Environment to a first-class,
-- versioned resource. Agents now reference an environment by id + version.
-- The prior `SandboxPolicy` inline shape on workflow specs is being removed in
-- a follow-up commit — this migration only prepares the new schema; the
-- migration of existing policies into environments runs at deploy time from
-- the backfill service.

CREATE TABLE "environments" (
  "id" text NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "avatar" text NULL,
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "runtime" text NOT NULL DEFAULT 'cloud',
  "current_version_id" text NULL,
  "created_by" text NULL,
  "is_archived" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_environments_slug" UNIQUE ("slug"),
  CONSTRAINT "environments_created_by_users_id_fk" FOREIGN KEY ("created_by")
    REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE SET NULL
);
CREATE INDEX "idx_environments_archived" ON "environments" ("is_archived");

CREATE TABLE "environment_versions" (
  "id" text NOT NULL,
  "environment_id" text NOT NULL,
  "version" integer NOT NULL,
  "config" jsonb NOT NULL,
  "config_hash" text NOT NULL,
  "changelog" text NULL,
  "published_at" timestamp NULL,
  "published_by" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_environment_version" UNIQUE ("environment_id", "version"),
  CONSTRAINT "environment_versions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id")
    REFERENCES "environments" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "environment_versions_published_by_users_id_fk" FOREIGN KEY ("published_by")
    REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE SET NULL
);
CREATE INDEX "idx_environment_versions_hash" ON "environment_versions" ("config_hash");
CREATE INDEX "idx_environment_versions_environment" ON "environment_versions" ("environment_id");

-- Extend agents with environment reference + a placeholder for vault IDs (Phase 2).
ALTER TABLE "agents"
  ADD COLUMN "environment_id" text NULL,
  ADD COLUMN "environment_version" integer NULL,
  ADD COLUMN "default_vault_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT "agents_environment_id_environments_id_fk" FOREIGN KEY ("environment_id")
    REFERENCES "environments" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

CREATE INDEX "idx_agents_environment" ON "agents" ("environment_id");
