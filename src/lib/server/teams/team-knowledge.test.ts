/**
 * Team knowledge store — real SQL against PGlite. Pins the upsert-as-revision
 * contract (one row per (team, path)), team scoping, and the index projection.
 */

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createPgliteDb } from "$lib/server/db/pglite-compat";
import { PostgresTeamStore } from "$lib/server/application/adapters/team-store";
import type { TeamStore } from "$lib/server/application/ports";

async function freshStore(): Promise<TeamStore> {
	const { db } = createPgliteDb();
	await db.execute(
		sql.raw(`
		CREATE TABLE team_knowledge (
			id text PRIMARY KEY,
			team_id text NOT NULL,
			path text NOT NULL,
			type text NOT NULL,
			title text,
			description text,
			resource text,
			tags jsonb NOT NULL DEFAULT '[]'::jsonb,
			body text NOT NULL DEFAULT '',
			created_by_session_id text,
			created_at timestamp NOT NULL DEFAULT now(),
			updated_at timestamp NOT NULL DEFAULT now(),
			CONSTRAINT team_knowledge_team_path_unique UNIQUE (team_id, path)
		)`),
	);
	return new PostgresTeamStore(() => db as never);
}

describe("team knowledge store", () => {
	let store: TeamStore;
	beforeEach(async () => {
		store = await freshStore();
	});

	it("publishes a concept and reads it back", async () => {
		await store.upsertKnowledge({
			teamId: "t1",
			path: "findings/use-cases.md",
			type: "Finding",
			title: "Use-cases",
			description: "Five one-liners.",
			resource: "https://example.com/source",
			tags: ["research"],
			body: "1. Cost.",
			createdBySessionId: "s-researcher",
		});
		const row = await store.getKnowledge("t1", "findings/use-cases.md");
		expect(row?.type).toBe("Finding");
		expect(row?.body).toBe("1. Cost.");
		expect(row?.tags).toEqual(["research"]);
		expect(row?.resource).toBe("https://example.com/source");
	});

	it("re-publishing the same path is a revision, not a duplicate", async () => {
		await store.upsertKnowledge({
			teamId: "t1",
			path: "draft.md",
			type: "Draft",
			body: "v1",
		});
		await store.upsertKnowledge({
			teamId: "t1",
			path: "draft.md",
			type: "Deliverable",
			body: "v2 final",
		});
		const index = await store.listKnowledge("t1");
		expect(index).toHaveLength(1);
		const row = await store.getKnowledge("t1", "draft.md");
		expect(row?.type).toBe("Deliverable");
		expect(row?.body).toBe("v2 final");
	});

	it("scopes by team and filters the index by type", async () => {
		await store.upsertKnowledge({ teamId: "t1", path: "a.md", type: "Finding", body: "" });
		await store.upsertKnowledge({ teamId: "t1", path: "b.md", type: "Deliverable", body: "" });
		await store.upsertKnowledge({ teamId: "t2", path: "a.md", type: "Finding", body: "" });
		expect(await store.listKnowledge("t1")).toHaveLength(2);
		expect(await store.listKnowledge("t2")).toHaveLength(1);
		const findings = await store.listKnowledge("t1", { type: "Finding" });
		expect(findings.map((e) => e.path)).toEqual(["a.md"]);
		// Index rows carry frontmatter fields but never the body.
		expect(findings[0]).not.toHaveProperty("body");
	});
});
