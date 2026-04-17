-- Named Agents refactor: drop the unused legacy `agents` + `agent_profile_applied_history`
-- tables from the prior Mastra-style design and create a new `agents` + `agent_versions`
-- pair backing the /agents library UI. Workflow nodes will reference agents by
-- { id, version } and the execute handler resolves the ref server-side before
-- dispatching to dapr-agent-py.

-- Drop legacy agents scaffolding. These had zero live query references.
DROP TABLE IF EXISTS "agent_profile_applied_history" CASCADE;
DROP TABLE IF EXISTS "agents" CASCADE;

-- New agents library
CREATE TABLE "agents" (
  "id" text NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "avatar" text NULL,
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "runtime" text NOT NULL DEFAULT 'dapr-agent-py',
  "current_version_id" text NULL,
  "source_template_slug" text NULL,
  "source_template_version" integer NULL,
  "created_by" text NULL,
  "is_archived" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_agents_slug" UNIQUE ("slug"),
  CONSTRAINT "agents_created_by_users_id_fk" FOREIGN KEY ("created_by")
    REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE SET NULL
);
CREATE INDEX "idx_agents_archived" ON "agents" ("is_archived");

CREATE TABLE "agent_versions" (
  "id" text NOT NULL,
  "agent_id" text NOT NULL,
  "version" integer NOT NULL,
  "config" jsonb NOT NULL,
  "config_hash" text NOT NULL,
  "changelog" text NULL,
  "published_at" timestamp NULL,
  "published_by" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_agent_version" UNIQUE ("agent_id", "version"),
  CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id")
    REFERENCES "agents" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "agent_versions_published_by_users_id_fk" FOREIGN KEY ("published_by")
    REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE SET NULL
);
CREATE INDEX "idx_agent_versions_hash" ON "agent_versions" ("config_hash");
CREATE INDEX "idx_agent_versions_agent" ON "agent_versions" ("agent_id");
