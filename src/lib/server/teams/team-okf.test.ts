/**
 * OKF serialization + path rules. Pins conformance-critical behavior: every
 * concept renders parseable frontmatter with a non-empty `type`; reserved
 * filenames are refused; index/log follow the v0.1 reserved-file shapes.
 */

import { describe, expect, it } from "vitest";
import {
	renderBundle,
	renderConcept,
	renderIndex,
	renderLog,
	sanitizeKnowledgePath,
} from "$lib/server/teams/team-okf";

describe("sanitizeKnowledgePath", () => {
	it("normalizes: strips leading slashes, appends .md", () => {
		expect(sanitizeKnowledgePath("/findings/use-cases")).toEqual({
			path: "findings/use-cases.md",
		});
	});
	it("refuses traversal, bad charset, and reserved names", () => {
		expect(sanitizeKnowledgePath("../evil.md")).toHaveProperty("error");
		expect(sanitizeKnowledgePath("a/../b.md")).toHaveProperty("error");
		expect(sanitizeKnowledgePath("sp ace.md")).toHaveProperty("error");
		expect(sanitizeKnowledgePath("findings/index.md")).toHaveProperty("error");
		expect(sanitizeKnowledgePath("log.md")).toHaveProperty("error");
		expect(sanitizeKnowledgePath("")).toHaveProperty("error");
	});
});

describe("renderConcept", () => {
	it("emits frontmatter with required type + recommended fields, then the body", () => {
		const doc = renderConcept({
			type: "Finding",
			title: 'Use-cases: "suspend" agents',
			description: "Five one-liners.",
			tags: ["research"],
			updated_at: "2026-07-11 12:00:00",
			body: "1. Cost.\n\nSee [summary](/deliverable/summary.md).",
		});
		expect(doc.startsWith("---\n")).toBe(true);
		expect(doc).toContain('type: "Finding"');
		// Quotes in titles must stay valid YAML (JSON-encoded scalars).
		expect(doc).toContain('title: "Use-cases: \\"suspend\\" agents"');
		expect(doc).toContain("tags: [\"research\"]");
		expect(doc).toContain("timestamp:");
		expect(doc.split("---\n").length).toBeGreaterThanOrEqual(3);
		expect(doc).toContain("[summary](/deliverable/summary.md)");
	});
});

const ENTRIES = [
	{
		path: "findings/use-cases.md",
		type: "Finding",
		title: "Use-cases",
		description: "Five one-liners.",
		tags: [],
		created_by_session_id: "s1",
		created_at: "2026-07-11T12:00:00Z",
		updated_at: "2026-07-11T12:05:00Z",
	},
	{
		path: "deliverable/summary.md",
		type: "Deliverable",
		title: "Summary",
		description: null,
		tags: [],
		created_by_session_id: "s2",
		created_at: "2026-07-11T12:10:00Z",
		updated_at: "2026-07-11T12:10:00Z",
	},
];

describe("renderIndex / renderLog / renderBundle", () => {
	it("index carries the okf_version declaration and type-grouped links", () => {
		const idx = renderIndex("team-research", ENTRIES);
		expect(idx).toContain('okf_version: "0.1"');
		expect(idx).toContain("## Finding");
		expect(idx).toContain("## Deliverable");
		expect(idx).toContain("[Use-cases](/findings/use-cases.md) — Five one-liners.");
	});
	it("log is newest-first with ISO date headings and creation/update verbs", () => {
		const log = renderLog(ENTRIES);
		expect(log).toContain("## 2026-07-11");
		// summary (created==updated) is a Creation; use-cases (revised) an Update.
		expect(log.indexOf("**Creation** [Summary]")).toBeLessThan(
			log.indexOf("**Update** [Use-cases]"),
		);
	});
	it("bundle = index + log + one file per concept", () => {
		const files = renderBundle(
			"team-research",
			ENTRIES,
			ENTRIES.map((e) => ({ ...e, id: "x", team_id: "t", body: "content" })),
		);
		expect(files.map((f) => f.path)).toEqual([
			"index.md",
			"log.md",
			"findings/use-cases.md",
			"deliverable/summary.md",
		]);
		for (const f of files.slice(2)) expect(f.content).toContain("type:");
	});
});
