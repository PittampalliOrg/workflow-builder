-- Agent Teams: shared KNOWLEDGE layer (Open Knowledge Format-shaped).
--
-- The completion note (0104) is the coordination-sized results channel; this is
-- the CONTENT layer: teammates publish findings/drafts/deliverables as concept
-- documents (one row per bundle-relative path), the synthesizer + UI + future
-- runs read them, and the whole team bundle serializes losslessly to an OKF
-- v0.1 directory (markdown + YAML frontmatter; see src/lib/server/teams/team-okf.ts).
-- One row per (team, path): concurrent teammates write DIFFERENT concepts, so
-- there is no write contention; re-publishing a path is an upsert (revision).
CREATE TABLE IF NOT EXISTS "team_knowledge" (
	"id" text PRIMARY KEY,
	"team_id" text NOT NULL,
	-- Bundle-relative path WITHOUT a leading slash, always ending in .md
	-- (e.g. 'findings/use-cases.md'). Sanitized app-side.
	"path" text NOT NULL,
	-- OKF's single required frontmatter field. Producer-chosen (Finding,
	-- Draft, Deliverable, Hypothesis, ...); consumers tolerate unknowns.
	"type" text NOT NULL,
	"title" text,
	"description" text,
	"tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
	-- Markdown body. Cross-links to other concepts are ordinary markdown
	-- links inside the body (OKF: links are untyped directed edges).
	"body" text NOT NULL DEFAULT '',
	"created_by_session_id" text,
	"created_at" timestamp NOT NULL DEFAULT now(),
	"updated_at" timestamp NOT NULL DEFAULT now(),
	CONSTRAINT "team_knowledge_team_path_unique" UNIQUE ("team_id", "path")
);

CREATE INDEX IF NOT EXISTS "team_knowledge_team_idx" ON "team_knowledge" ("team_id");
