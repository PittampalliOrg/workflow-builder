-- Create "agent_capability_facets" table
CREATE TABLE "agent_capability_facets" (
  "id" text NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_capability_facets_slug_unique" UNIQUE ("slug")
);
-- Create index "idx_agent_capability_facets_enabled" to table: "agent_capability_facets"
CREATE INDEX "idx_agent_capability_facets_enabled" ON "agent_capability_facets" ("is_enabled");
-- Create index "idx_agent_capability_facets_sort" to table: "agent_capability_facets"
CREATE INDEX "idx_agent_capability_facets_sort" ON "agent_capability_facets" ("sort_order");
-- Create "agent_capability_facet_versions" table
CREATE TABLE "agent_capability_facet_versions" (
  "id" text NOT NULL,
  "facet_id" text NOT NULL,
  "version" integer NOT NULL,
  "config" jsonb NOT NULL,
  "compatibility" jsonb NULL,
  "is_default" boolean NOT NULL DEFAULT false,
  "notes" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_agent_capability_facet_version" UNIQUE ("facet_id", "version"),
  CONSTRAINT "agent_capability_facet_versions_facet_id_agent_capability_facet" FOREIGN KEY ("facet_id") REFERENCES "agent_capability_facets" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_agent_capability_facet_versions_default" to table: "agent_capability_facet_versions"
CREATE INDEX "idx_agent_capability_facet_versions_default" ON "agent_capability_facet_versions" ("is_default");
-- Create index "idx_agent_capability_facet_versions_facet" to table: "agent_capability_facet_versions"
CREATE INDEX "idx_agent_capability_facet_versions_facet" ON "agent_capability_facet_versions" ("facet_id");
-- Create "agent_execution_facets" table
CREATE TABLE "agent_execution_facets" (
  "id" text NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_execution_facets_slug_unique" UNIQUE ("slug")
);
-- Create index "idx_agent_execution_facets_enabled" to table: "agent_execution_facets"
CREATE INDEX "idx_agent_execution_facets_enabled" ON "agent_execution_facets" ("is_enabled");
-- Create index "idx_agent_execution_facets_sort" to table: "agent_execution_facets"
CREATE INDEX "idx_agent_execution_facets_sort" ON "agent_execution_facets" ("sort_order");
-- Create "agent_execution_facet_versions" table
CREATE TABLE "agent_execution_facet_versions" (
  "id" text NOT NULL,
  "facet_id" text NOT NULL,
  "version" integer NOT NULL,
  "config" jsonb NOT NULL,
  "compatibility" jsonb NULL,
  "is_default" boolean NOT NULL DEFAULT false,
  "notes" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_agent_execution_facet_version" UNIQUE ("facet_id", "version"),
  CONSTRAINT "agent_execution_facet_versions_facet_id_agent_execution_facets_" FOREIGN KEY ("facet_id") REFERENCES "agent_execution_facets" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_agent_execution_facet_versions_default" to table: "agent_execution_facet_versions"
CREATE INDEX "idx_agent_execution_facet_versions_default" ON "agent_execution_facet_versions" ("is_default");
-- Create index "idx_agent_execution_facet_versions_facet" to table: "agent_execution_facet_versions"
CREATE INDEX "idx_agent_execution_facet_versions_facet" ON "agent_execution_facet_versions" ("facet_id");
-- Create "agent_instruction_facets" table
CREATE TABLE "agent_instruction_facets" (
  "id" text NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_instruction_facets_slug_unique" UNIQUE ("slug")
);
-- Create index "idx_agent_instruction_facets_enabled" to table: "agent_instruction_facets"
CREATE INDEX "idx_agent_instruction_facets_enabled" ON "agent_instruction_facets" ("is_enabled");
-- Create index "idx_agent_instruction_facets_sort" to table: "agent_instruction_facets"
CREATE INDEX "idx_agent_instruction_facets_sort" ON "agent_instruction_facets" ("sort_order");
-- Create "agent_instruction_facet_versions" table
CREATE TABLE "agent_instruction_facet_versions" (
  "id" text NOT NULL,
  "facet_id" text NOT NULL,
  "version" integer NOT NULL,
  "config" jsonb NOT NULL,
  "compatibility" jsonb NULL,
  "is_default" boolean NOT NULL DEFAULT false,
  "notes" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_agent_instruction_facet_version" UNIQUE ("facet_id", "version"),
  CONSTRAINT "agent_instruction_facet_versions_facet_id_agent_instruction_fac" FOREIGN KEY ("facet_id") REFERENCES "agent_instruction_facets" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_agent_instruction_facet_versions_default" to table: "agent_instruction_facet_versions"
CREATE INDEX "idx_agent_instruction_facet_versions_default" ON "agent_instruction_facet_versions" ("is_default");
-- Create index "idx_agent_instruction_facet_versions_facet" to table: "agent_instruction_facet_versions"
CREATE INDEX "idx_agent_instruction_facet_versions_facet" ON "agent_instruction_facet_versions" ("facet_id");
-- Create "agent_interaction_facets" table
CREATE TABLE "agent_interaction_facets" (
  "id" text NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_interaction_facets_slug_unique" UNIQUE ("slug")
);
-- Create index "idx_agent_interaction_facets_enabled" to table: "agent_interaction_facets"
CREATE INDEX "idx_agent_interaction_facets_enabled" ON "agent_interaction_facets" ("is_enabled");
-- Create index "idx_agent_interaction_facets_sort" to table: "agent_interaction_facets"
CREATE INDEX "idx_agent_interaction_facets_sort" ON "agent_interaction_facets" ("sort_order");
-- Create "agent_interaction_facet_versions" table
CREATE TABLE "agent_interaction_facet_versions" (
  "id" text NOT NULL,
  "facet_id" text NOT NULL,
  "version" integer NOT NULL,
  "config" jsonb NOT NULL,
  "compatibility" jsonb NULL,
  "is_default" boolean NOT NULL DEFAULT false,
  "notes" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_agent_interaction_facet_version" UNIQUE ("facet_id", "version"),
  CONSTRAINT "agent_interaction_facet_versions_facet_id_agent_interaction_fac" FOREIGN KEY ("facet_id") REFERENCES "agent_interaction_facets" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_agent_interaction_facet_versions_default" to table: "agent_interaction_facet_versions"
CREATE INDEX "idx_agent_interaction_facet_versions_default" ON "agent_interaction_facet_versions" ("is_default");
-- Create index "idx_agent_interaction_facet_versions_facet" to table: "agent_interaction_facet_versions"
CREATE INDEX "idx_agent_interaction_facet_versions_facet" ON "agent_interaction_facet_versions" ("facet_id");
-- Create "agent_memory_facets" table
CREATE TABLE "agent_memory_facets" (
  "id" text NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_memory_facets_slug_unique" UNIQUE ("slug")
);
-- Create index "idx_agent_memory_facets_enabled" to table: "agent_memory_facets"
CREATE INDEX "idx_agent_memory_facets_enabled" ON "agent_memory_facets" ("is_enabled");
-- Create index "idx_agent_memory_facets_sort" to table: "agent_memory_facets"
CREATE INDEX "idx_agent_memory_facets_sort" ON "agent_memory_facets" ("sort_order");
-- Create "agent_memory_facet_versions" table
CREATE TABLE "agent_memory_facet_versions" (
  "id" text NOT NULL,
  "facet_id" text NOT NULL,
  "version" integer NOT NULL,
  "config" jsonb NOT NULL,
  "compatibility" jsonb NULL,
  "is_default" boolean NOT NULL DEFAULT false,
  "notes" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_agent_memory_facet_version" UNIQUE ("facet_id", "version"),
  CONSTRAINT "agent_memory_facet_versions_facet_id_agent_memory_facets_id_fk" FOREIGN KEY ("facet_id") REFERENCES "agent_memory_facets" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_agent_memory_facet_versions_default" to table: "agent_memory_facet_versions"
CREATE INDEX "idx_agent_memory_facet_versions_default" ON "agent_memory_facet_versions" ("is_default");
-- Create index "idx_agent_memory_facet_versions_facet" to table: "agent_memory_facet_versions"
CREATE INDEX "idx_agent_memory_facet_versions_facet" ON "agent_memory_facet_versions" ("facet_id");
-- Create "agent_model_facets" table
CREATE TABLE "agent_model_facets" (
  "id" text NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_model_facets_slug_unique" UNIQUE ("slug")
);
-- Create index "idx_agent_model_facets_enabled" to table: "agent_model_facets"
CREATE INDEX "idx_agent_model_facets_enabled" ON "agent_model_facets" ("is_enabled");
-- Create index "idx_agent_model_facets_sort" to table: "agent_model_facets"
CREATE INDEX "idx_agent_model_facets_sort" ON "agent_model_facets" ("sort_order");
-- Create "agent_model_facet_versions" table
CREATE TABLE "agent_model_facet_versions" (
  "id" text NOT NULL,
  "facet_id" text NOT NULL,
  "version" integer NOT NULL,
  "config" jsonb NOT NULL,
  "compatibility" jsonb NULL,
  "is_default" boolean NOT NULL DEFAULT false,
  "notes" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_agent_model_facet_version" UNIQUE ("facet_id", "version"),
  CONSTRAINT "agent_model_facet_versions_facet_id_agent_model_facets_id_fk" FOREIGN KEY ("facet_id") REFERENCES "agent_model_facets" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_agent_model_facet_versions_default" to table: "agent_model_facet_versions"
CREATE INDEX "idx_agent_model_facet_versions_default" ON "agent_model_facet_versions" ("is_default");
-- Create index "idx_agent_model_facet_versions_facet" to table: "agent_model_facet_versions"
CREATE INDEX "idx_agent_model_facet_versions_facet" ON "agent_model_facet_versions" ("facet_id");
-- Create "agent_output_facets" table
CREATE TABLE "agent_output_facets" (
  "id" text NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_output_facets_slug_unique" UNIQUE ("slug")
);
-- Create index "idx_agent_output_facets_enabled" to table: "agent_output_facets"
CREATE INDEX "idx_agent_output_facets_enabled" ON "agent_output_facets" ("is_enabled");
-- Create index "idx_agent_output_facets_sort" to table: "agent_output_facets"
CREATE INDEX "idx_agent_output_facets_sort" ON "agent_output_facets" ("sort_order");
-- Create "agent_output_facet_versions" table
CREATE TABLE "agent_output_facet_versions" (
  "id" text NOT NULL,
  "facet_id" text NOT NULL,
  "version" integer NOT NULL,
  "config" jsonb NOT NULL,
  "compatibility" jsonb NULL,
  "is_default" boolean NOT NULL DEFAULT false,
  "notes" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_agent_output_facet_version" UNIQUE ("facet_id", "version"),
  CONSTRAINT "agent_output_facet_versions_facet_id_agent_output_facets_id_fk" FOREIGN KEY ("facet_id") REFERENCES "agent_output_facets" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_agent_output_facet_versions_default" to table: "agent_output_facet_versions"
CREATE INDEX "idx_agent_output_facet_versions_default" ON "agent_output_facet_versions" ("is_default");
-- Create index "idx_agent_output_facet_versions_facet" to table: "agent_output_facet_versions"
CREATE INDEX "idx_agent_output_facet_versions_facet" ON "agent_output_facet_versions" ("facet_id");
-- Create "agent_profile_templates" table
CREATE TABLE "agent_profile_templates" (
  "id" text NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "category" text NULL,
  "source_repo_url" text NULL,
  "source_path" text NULL,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_profile_templates_slug_unique" UNIQUE ("slug")
);
-- Create index "idx_agent_profile_templates_enabled" to table: "agent_profile_templates"
CREATE INDEX "idx_agent_profile_templates_enabled" ON "agent_profile_templates" ("is_enabled");
-- Create index "idx_agent_profile_templates_sort" to table: "agent_profile_templates"
CREATE INDEX "idx_agent_profile_templates_sort" ON "agent_profile_templates" ("sort_order");
-- Modify "agents" table
ALTER TABLE "agents" ADD COLUMN "agent_profile_template_id" text NULL, ADD COLUMN "agent_profile_template_version" integer NULL, ADD CONSTRAINT "agents_agent_profile_template_id_agent_profile_templates_id_fk" FOREIGN KEY ("agent_profile_template_id") REFERENCES "agent_profile_templates" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
-- Create "agent_profile_applied_history" table
CREATE TABLE "agent_profile_applied_history" (
  "id" text NOT NULL,
  "agent_id" text NOT NULL,
  "template_id" text NOT NULL,
  "template_version" integer NOT NULL,
  "applied_by_user_id" text NOT NULL,
  "source" text NOT NULL DEFAULT 'ui',
  "snapshot" jsonb NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_profile_applied_history_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "agent_profile_applied_history_applied_by_user_id_users_id_fk" FOREIGN KEY ("applied_by_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "agent_profile_applied_history_template_id_agent_profile_templat" FOREIGN KEY ("template_id") REFERENCES "agent_profile_templates" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create index "idx_agent_profile_applied_history_agent" to table: "agent_profile_applied_history"
CREATE INDEX "idx_agent_profile_applied_history_agent" ON "agent_profile_applied_history" ("agent_id");
-- Create index "idx_agent_profile_applied_history_created" to table: "agent_profile_applied_history"
CREATE INDEX "idx_agent_profile_applied_history_created" ON "agent_profile_applied_history" ("created_at");
-- Create index "idx_agent_profile_applied_history_template" to table: "agent_profile_applied_history"
CREATE INDEX "idx_agent_profile_applied_history_template" ON "agent_profile_applied_history" ("template_id");
-- Create "agent_profile_template_examples" table
CREATE TABLE "agent_profile_template_examples" (
  "id" text NOT NULL,
  "template_id" text NOT NULL,
  "label" text NOT NULL,
  "source_repo_url" text NOT NULL,
  "source_path" text NOT NULL,
  "notes" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_profile_template_examples_template_id_agent_profile_templ" FOREIGN KEY ("template_id") REFERENCES "agent_profile_templates" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create "agent_tool_policy_facets" table
CREATE TABLE "agent_tool_policy_facets" (
  "id" text NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_tool_policy_facets_slug_unique" UNIQUE ("slug")
);
-- Create index "idx_agent_tool_policy_facets_enabled" to table: "agent_tool_policy_facets"
CREATE INDEX "idx_agent_tool_policy_facets_enabled" ON "agent_tool_policy_facets" ("is_enabled");
-- Create index "idx_agent_tool_policy_facets_sort" to table: "agent_tool_policy_facets"
CREATE INDEX "idx_agent_tool_policy_facets_sort" ON "agent_tool_policy_facets" ("sort_order");
-- Create "agent_tool_policy_facet_versions" table
CREATE TABLE "agent_tool_policy_facet_versions" (
  "id" text NOT NULL,
  "facet_id" text NOT NULL,
  "version" integer NOT NULL,
  "config" jsonb NOT NULL,
  "compatibility" jsonb NULL,
  "is_default" boolean NOT NULL DEFAULT false,
  "notes" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_agent_tool_policy_facet_version" UNIQUE ("facet_id", "version"),
  CONSTRAINT "agent_tool_policy_facet_versions_facet_id_agent_tool_policy_fac" FOREIGN KEY ("facet_id") REFERENCES "agent_tool_policy_facets" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "idx_agent_tool_policy_facet_versions_default" to table: "agent_tool_policy_facet_versions"
CREATE INDEX "idx_agent_tool_policy_facet_versions_default" ON "agent_tool_policy_facet_versions" ("is_default");
-- Create index "idx_agent_tool_policy_facet_versions_facet" to table: "agent_tool_policy_facet_versions"
CREATE INDEX "idx_agent_tool_policy_facet_versions_facet" ON "agent_tool_policy_facet_versions" ("facet_id");
-- Create "agent_profile_template_versions" table
CREATE TABLE "agent_profile_template_versions" (
  "id" text NOT NULL,
  "template_id" text NOT NULL,
  "version" integer NOT NULL,
  "instruction_facet_version_id" text NULL,
  "model_facet_version_id" text NULL,
  "tool_policy_facet_version_id" text NULL,
  "memory_facet_version_id" text NULL,
  "execution_facet_version_id" text NULL,
  "interaction_facet_version_id" text NULL,
  "output_facet_version_id" text NULL,
  "capability_facet_version_id" text NULL,
  "compatibility" jsonb NULL,
  "notes" text NULL,
  "is_default" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_agent_profile_template_version" UNIQUE ("template_id", "version"),
  CONSTRAINT "agent_profile_template_versions_capability_facet_version_id_age" FOREIGN KEY ("capability_facet_version_id") REFERENCES "agent_capability_facet_versions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "agent_profile_template_versions_execution_facet_version_id_agen" FOREIGN KEY ("execution_facet_version_id") REFERENCES "agent_execution_facet_versions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "agent_profile_template_versions_instruction_facet_version_id_ag" FOREIGN KEY ("instruction_facet_version_id") REFERENCES "agent_instruction_facet_versions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "agent_profile_template_versions_interaction_facet_version_id_ag" FOREIGN KEY ("interaction_facet_version_id") REFERENCES "agent_interaction_facet_versions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "agent_profile_template_versions_memory_facet_version_id_agent_m" FOREIGN KEY ("memory_facet_version_id") REFERENCES "agent_memory_facet_versions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "agent_profile_template_versions_model_facet_version_id_agent_mo" FOREIGN KEY ("model_facet_version_id") REFERENCES "agent_model_facet_versions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "agent_profile_template_versions_output_facet_version_id_agent_o" FOREIGN KEY ("output_facet_version_id") REFERENCES "agent_output_facet_versions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "agent_profile_template_versions_template_id_agent_profile_templ" FOREIGN KEY ("template_id") REFERENCES "agent_profile_templates" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "agent_profile_template_versions_tool_policy_facet_version_id_ag" FOREIGN KEY ("tool_policy_facet_version_id") REFERENCES "agent_tool_policy_facet_versions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create index "idx_agent_profile_template_versions_default" to table: "agent_profile_template_versions"
CREATE INDEX "idx_agent_profile_template_versions_default" ON "agent_profile_template_versions" ("is_default");
-- Create index "idx_agent_profile_template_versions_template" to table: "agent_profile_template_versions"
CREATE INDEX "idx_agent_profile_template_versions_template" ON "agent_profile_template_versions" ("template_id");

-- Seed instruction facets
INSERT INTO "agent_instruction_facets" ("id", "slug", "name", "description", "sort_order")
VALUES
  ('f_instr_browsing', 'browsing-agent', 'Browsing Agent Instructions', 'Guidance for browsing and page extraction patterns.', 10),
  ('f_instr_coding', 'coding-agent', 'Coding Agent Instructions', 'Guidance for iterative coding, debugging, and validation loops.', 20),
  ('f_instr_deep_research', 'deep-research-agent', 'Deep Research Instructions', 'Guidance for search-plan-summarize-report workflows.', 30),
  ('f_instr_docs', 'docs-chatbot-agent', 'Docs Chatbot Instructions', 'Guidance for documentation QA and citation-driven answers.', 40),
  ('f_instr_meeting', 'meeting-scheduler-agent', 'Meeting Scheduler Instructions', 'Guidance for calendar-aware scheduling assistants.', 50),
  ('f_instr_sql', 'text-to-sql-agent', 'Text-to-SQL Instructions', 'Guidance for schema-aware SQL generation and safe execution.', 60);

INSERT INTO "agent_instruction_facet_versions" ("id", "facet_id", "version", "config", "is_default")
VALUES
  ('fv_instr_browsing_v1', 'f_instr_browsing', 1, '{"instructions":"You are a web browsing assistant. Navigate content, extract relevant details, and summarize findings with clear evidence and concise conclusions."}', true),
  ('fv_instr_coding_v1', 'f_instr_coding', 1, '{"instructions":"You are a coding assistant. Break work into steps, inspect files first, make minimal safe edits, run validation, and explain tradeoffs clearly."}', true),
  ('fv_instr_deep_research_v1', 'f_instr_deep_research', 1, '{"instructions":"You are a deep research assistant. Plan queries, gather diverse sources, synthesize key findings, and deliver a structured report with assumptions."}', true),
  ('fv_instr_docs_v1', 'f_instr_docs', 1, '{"instructions":"You are a documentation assistant. Answer based on trusted references, call out uncertainty, and prefer explicit links and version-aware guidance."}', true),
  ('fv_instr_meeting_v1', 'f_instr_meeting', 1, '{"instructions":"You are a meeting scheduler. Collect constraints, propose available slots, and confirm final details clearly before scheduling."}', true),
  ('fv_instr_sql_v1', 'f_instr_sql', 1, '{"instructions":"You are a text-to-sql assistant. Inspect schema first, generate safe SQL, explain intent, and avoid destructive queries unless explicitly requested."}', true);

-- Seed model facets
INSERT INTO "agent_model_facets" ("id", "slug", "name", "description", "sort_order")
VALUES
  ('f_model_balanced', 'balanced-model', 'Balanced Model', 'Default balanced model profile.', 10),
  ('f_model_reasoning', 'reasoning-model', 'Reasoning Model', 'Higher reasoning model profile for complex tasks.', 20),
  ('f_model_claude_planning', 'claude-planning-model', 'Claude Planning Model', 'Planning-friendly Claude model profile.', 30),
  ('f_model_sql', 'sql-model', 'SQL Model', 'SQL-focused model profile.', 40);

INSERT INTO "agent_model_facet_versions" ("id", "facet_id", "version", "config", "is_default")
VALUES
  ('fv_model_balanced_v1', 'f_model_balanced', 1, '{"provider":"openai","name":"gpt-4o"}', true),
  ('fv_model_reasoning_v1', 'f_model_reasoning', 1, '{"provider":"openai","name":"gpt-5.2-codex"}', true),
  ('fv_model_claude_planning_v1', 'f_model_claude_planning', 1, '{"provider":"anthropic","name":"claude-sonnet-4-6"}', true),
  ('fv_model_sql_v1', 'f_model_sql', 1, '{"provider":"openai","name":"gpt-4.1-mini"}', true);

-- Seed tool policy facets
INSERT INTO "agent_tool_policy_facets" ("id", "slug", "name", "description", "sort_order")
VALUES
  ('f_tool_research', 'workspace-research-tools', 'Workspace Research Tools', 'Read-first toolset for research-heavy agents.', 10),
  ('f_tool_coding', 'workspace-coding-tools', 'Workspace Coding Tools', 'Full coding-oriented workspace toolset.', 20),
  ('f_tool_docs_mcp', 'docs-mcp-tools', 'Docs MCP Tooling', 'Profile expects MCP/remote tooling.', 30),
  ('f_tool_scheduler', 'scheduler-integration-tools', 'Scheduler Integration Tools', 'Profile expects calendar/email integrations.', 40),
  ('f_tool_sql', 'sql-analysis-tools', 'SQL Analysis Tools', 'Tooling oriented toward database and query analysis.', 50);

INSERT INTO "agent_tool_policy_facet_versions" ("id", "facet_id", "version", "config", "compatibility", "is_default")
VALUES
  (
    'fv_tool_research_v1',
    'f_tool_research',
    1,
    '{"tools":[{"type":"workspace","ref":"read_file"},{"type":"workspace","ref":"list_files"},{"type":"workspace","ref":"file_stat"},{"type":"workspace","ref":"execute_command"}]}',
    NULL,
    true
  ),
  (
    'fv_tool_coding_v1',
    'f_tool_coding',
    1,
    '{"tools":[{"type":"workspace","ref":"read_file"},{"type":"workspace","ref":"write_file"},{"type":"workspace","ref":"edit_file"},{"type":"workspace","ref":"list_files"},{"type":"workspace","ref":"delete_file"},{"type":"workspace","ref":"mkdir"},{"type":"workspace","ref":"file_stat"},{"type":"workspace","ref":"execute_command"}]}',
    NULL,
    true
  ),
  (
    'fv_tool_docs_mcp_v1',
    'f_tool_docs_mcp',
    1,
    '{"tools":[]}',
    '[{"code":"external_tooling_required","severity":"warning","message":"Template expects MCP-provided tools. Configure tool mappings before production use."}]',
    true
  ),
  (
    'fv_tool_scheduler_v1',
    'f_tool_scheduler',
    1,
    '{"tools":[]}',
    '[{"code":"external_tooling_required","severity":"warning","message":"Template expects calendar/email integrations. Configure provider-backed tools before production use."}]',
    true
  ),
  (
    'fv_tool_sql_v1',
    'f_tool_sql',
    1,
    '{"tools":[{"type":"workspace","ref":"read_file"},{"type":"workspace","ref":"list_files"},{"type":"workspace","ref":"execute_command"}]}',
    NULL,
    true
  );

-- Seed memory facets
INSERT INTO "agent_memory_facets" ("id", "slug", "name", "description", "sort_order")
VALUES
  ('f_memory_none', 'no-memory', 'No Memory', 'No explicit memory configuration.', 10),
  ('f_memory_thread', 'thread-memory', 'Thread Memory', 'Lightweight thread memory defaults.', 20);

INSERT INTO "agent_memory_facet_versions" ("id", "facet_id", "version", "config", "is_default")
VALUES
  ('fv_memory_none_v1', 'f_memory_none', 1, '{}', true),
  ('fv_memory_thread_v1', 'f_memory_thread', 1, '{"memoryConfig":{"type":"thread","enabled":true}}', true);

-- Seed execution facets
INSERT INTO "agent_execution_facets" ("id", "slug", "name", "description", "sort_order")
VALUES
  ('f_exec_default', 'default-execution', 'Default Execution', 'Balanced execution limits.', 10),
  ('f_exec_coding', 'coding-execution', 'Coding Execution', 'Higher limits for iterative coding.', 20),
  ('f_exec_research', 'research-execution', 'Research Execution', 'Higher limits for long-form research.', 30),
  ('f_exec_scheduler', 'scheduler-execution', 'Scheduler Execution', 'Lower latency scheduler execution limits.', 40);

INSERT INTO "agent_execution_facet_versions" ("id", "facet_id", "version", "config", "is_default")
VALUES
  ('fv_exec_default_v1', 'f_exec_default', 1, '{"maxTurns":50,"timeoutMinutes":30}', true),
  ('fv_exec_coding_v1', 'f_exec_coding', 1, '{"maxTurns":150,"timeoutMinutes":60}', true),
  ('fv_exec_research_v1', 'f_exec_research', 1, '{"maxTurns":120,"timeoutMinutes":60}', true),
  ('fv_exec_scheduler_v1', 'f_exec_scheduler', 1, '{"maxTurns":40,"timeoutMinutes":20}', true);

-- Seed interaction facets
INSERT INTO "agent_interaction_facets" ("id", "slug", "name", "description", "sort_order")
VALUES
  ('f_interaction_standard', 'standard-interaction', 'Standard Interaction', 'Standard interaction defaults.', 10),
  ('f_interaction_reasoning', 'reasoning-interaction', 'Reasoning Interaction', 'Lower temperature for analytical workflows.', 20);

INSERT INTO "agent_interaction_facet_versions" ("id", "facet_id", "version", "config", "is_default")
VALUES
  ('fv_interaction_standard_v1', 'f_interaction_standard', 1, '{}', true),
  ('fv_interaction_reasoning_v1', 'f_interaction_reasoning', 1, '{"defaultOptions":{"temperature":0.2}}', true);

-- Seed output facets
INSERT INTO "agent_output_facets" ("id", "slug", "name", "description", "sort_order")
VALUES
  ('f_output_freeform', 'freeform-output', 'Freeform Output', 'Unstructured text output.', 10),
  ('f_output_sql_structured', 'sql-structured-output', 'SQL Structured Output', 'Structured output for SQL/explanation responses.', 20);

INSERT INTO "agent_output_facet_versions" ("id", "facet_id", "version", "config", "is_default")
VALUES
  ('fv_output_freeform_v1', 'f_output_freeform', 1, '{}', true),
  ('fv_output_sql_structured_v1', 'f_output_sql_structured', 1, '{"structuredOutput":{"schema":{"type":"object","properties":{"sql":{"type":"string"},"explanation":{"type":"string"}},"required":["sql","explanation"]}}}', true);

-- Seed capability facets
INSERT INTO "agent_capability_facets" ("id", "slug", "name", "description", "sort_order")
VALUES
  ('f_cap_general', 'general-capability', 'General Capability', 'General-purpose assistant capability.', 10),
  ('f_cap_code', 'code-capability', 'Code Capability', 'Code-assistant capability profile.', 20),
  ('f_cap_research', 'research-capability', 'Research Capability', 'Research capability profile.', 30),
  ('f_cap_planning', 'planning-capability', 'Planning Capability', 'Planning capability profile.', 40);

INSERT INTO "agent_capability_facet_versions" ("id", "facet_id", "version", "config", "is_default")
VALUES
  ('fv_cap_general_v1', 'f_cap_general', 1, '{"agentType":"general"}', true),
  ('fv_cap_code_v1', 'f_cap_code', 1, '{"agentType":"code-assistant"}', true),
  ('fv_cap_research_v1', 'f_cap_research', 1, '{"agentType":"research"}', true),
  ('fv_cap_planning_v1', 'f_cap_planning', 1, '{"agentType":"planning"}', true);

-- Seed template definitions
INSERT INTO "agent_profile_templates" ("id", "slug", "name", "description", "category", "source_repo_url", "source_path", "sort_order")
VALUES
  ('tpl_browsing_agent', 'browsing-agent', 'Browsing Agent', 'Template profile inspired by Mastra browsing agent.', 'research', 'https://github.com/mastra-ai/mastra', 'templates/template-browsing-agent', 10),
  ('tpl_coding_agent', 'coding-agent', 'Coding Agent', 'Template profile inspired by Mastra coding agent.', 'engineering', 'https://github.com/mastra-ai/mastra', 'templates/template-coding-agent', 20),
  ('tpl_deep_research_agent', 'deep-research-agent', 'Deep Research Agent', 'Template profile inspired by Mastra deep research flows.', 'research', 'https://github.com/mastra-ai/mastra', 'templates/template-deep-research', 30),
  ('tpl_docs_chatbot_agent', 'docs-chatbot-agent', 'Docs Chatbot Agent', 'Template profile inspired by Mastra docs chatbot.', 'knowledge', 'https://github.com/mastra-ai/mastra', 'templates/template-docs-chatbot', 40),
  ('tpl_meeting_scheduler_agent', 'meeting-scheduler-agent', 'Meeting Scheduler Agent', 'Template profile inspired by Mastra meeting scheduler.', 'planning', 'https://github.com/mastra-ai/mastra', 'templates/template-meeting-scheduler', 50),
  ('tpl_text_to_sql_agent', 'text-to-sql-agent', 'Text-to-SQL Agent', 'Template profile inspired by Mastra text-to-sql.', 'data', 'https://github.com/mastra-ai/mastra', 'templates/template-text-to-sql', 60);

INSERT INTO "agent_profile_template_versions" (
  "id",
  "template_id",
  "version",
  "instruction_facet_version_id",
  "model_facet_version_id",
  "tool_policy_facet_version_id",
  "memory_facet_version_id",
  "execution_facet_version_id",
  "interaction_facet_version_id",
  "output_facet_version_id",
  "capability_facet_version_id",
  "is_default"
)
VALUES
  ('tpv_browsing_v1', 'tpl_browsing_agent', 1, 'fv_instr_browsing_v1', 'fv_model_balanced_v1', 'fv_tool_research_v1', 'fv_memory_thread_v1', 'fv_exec_default_v1', 'fv_interaction_standard_v1', 'fv_output_freeform_v1', 'fv_cap_research_v1', true),
  ('tpv_coding_v1', 'tpl_coding_agent', 1, 'fv_instr_coding_v1', 'fv_model_reasoning_v1', 'fv_tool_coding_v1', 'fv_memory_thread_v1', 'fv_exec_coding_v1', 'fv_interaction_reasoning_v1', 'fv_output_freeform_v1', 'fv_cap_code_v1', true),
  ('tpv_deep_research_v1', 'tpl_deep_research_agent', 1, 'fv_instr_deep_research_v1', 'fv_model_reasoning_v1', 'fv_tool_research_v1', 'fv_memory_thread_v1', 'fv_exec_research_v1', 'fv_interaction_reasoning_v1', 'fv_output_freeform_v1', 'fv_cap_research_v1', true),
  ('tpv_docs_v1', 'tpl_docs_chatbot_agent', 1, 'fv_instr_docs_v1', 'fv_model_balanced_v1', 'fv_tool_docs_mcp_v1', 'fv_memory_thread_v1', 'fv_exec_default_v1', 'fv_interaction_standard_v1', 'fv_output_freeform_v1', 'fv_cap_general_v1', true),
  ('tpv_meeting_v1', 'tpl_meeting_scheduler_agent', 1, 'fv_instr_meeting_v1', 'fv_model_claude_planning_v1', 'fv_tool_scheduler_v1', 'fv_memory_thread_v1', 'fv_exec_scheduler_v1', 'fv_interaction_standard_v1', 'fv_output_freeform_v1', 'fv_cap_planning_v1', true),
  ('tpv_sql_v1', 'tpl_text_to_sql_agent', 1, 'fv_instr_sql_v1', 'fv_model_sql_v1', 'fv_tool_sql_v1', 'fv_memory_none_v1', 'fv_exec_default_v1', 'fv_interaction_reasoning_v1', 'fv_output_sql_structured_v1', 'fv_cap_general_v1', true);

-- Seed template example mappings
INSERT INTO "agent_profile_template_examples" ("id", "template_id", "label", "source_repo_url", "source_path", "notes")
VALUES
  ('tpe_browsing_v1', 'tpl_browsing_agent', 'Mastra Browsing Agent', 'https://github.com/mastra-ai/mastra', 'templates/template-browsing-agent/src/mastra/agents/web-agent.ts', 'Single-agent browsing with navigation and extraction tools.'),
  ('tpe_coding_v1', 'tpl_coding_agent', 'Mastra Coding Agent', 'https://github.com/mastra-ai/mastra', 'templates/template-coding-agent/src/mastra/agents/coding-agent.ts', 'Coding-focused agent with higher iteration limits.'),
  ('tpe_deep_research_v1', 'tpl_deep_research_agent', 'Mastra Deep Research', 'https://github.com/mastra-ai/mastra', 'templates/template-deep-research/src/mastra/workflows/researchWorkflow.ts', 'Multi-agent workflow pattern mapped to a reusable profile.'),
  ('tpe_docs_v1', 'tpl_docs_chatbot_agent', 'Mastra Docs Chatbot', 'https://github.com/mastra-ai/mastra', 'templates/template-docs-chatbot/apps/agent/src/mastra/agents/docs-agent.ts', 'Documentation assistant pattern that expects MCP tools.'),
  ('tpe_meeting_v1', 'tpl_meeting_scheduler_agent', 'Mastra Meeting Scheduler', 'https://github.com/mastra-ai/mastra', 'templates/template-meeting-scheduler/src/mastra/agents/meeting-scheduler.ts', 'Planning assistant pattern expecting calendar/email integrations.'),
  ('tpe_sql_v1', 'tpl_text_to_sql_agent', 'Mastra Text-to-SQL', 'https://github.com/mastra-ai/mastra', 'templates/template-text-to-sql/src/mastra/agents/sql-agent.ts', 'Schema-aware SQL assistant with structured output options.');
