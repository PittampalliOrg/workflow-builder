/**
 * Agent Teams — Open Knowledge Format (OKF v0.1) serialization.
 *
 * The team knowledge layer stores concept documents in `team_knowledge` (one
 * row per bundle-relative path); this module is the OKF boundary: it renders a
 * row as a conformant concept document (YAML frontmatter with the required
 * `type` + recommended title/description/tags/timestamp, then the markdown
 * body) and a whole team's rows as a bundle (generated root `index.md` with
 * the `okf_version` declaration, generated `log.md`, one file per concept).
 *
 * OKF spec (v0.1): https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 * Conformance we rely on: every non-reserved .md has parseable frontmatter
 * with a non-empty `type`; index.md carries no frontmatter beyond the root
 * okf_version; log.md is newest-first with ISO-8601 date headings. Consumers
 * must tolerate unknown types/fields/broken links — which is what makes the
 * format safe for concurrently-writing agents.
 */

import type {
	TeamKnowledgeIndexEntry,
	TeamKnowledgeRow,
} from "$lib/server/application/ports";

export const OKF_VERSION = "0.1";

/** Guards: keep single documents prompt-sized and bundles bounded. */
export const KNOWLEDGE_MAX_BODY_BYTES = 64 * 1024;
export const KNOWLEDGE_MAX_PATH_LENGTH = 200;

const RESERVED_BASENAMES = new Set(["index.md", "log.md"]);
const SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Normalize + validate a bundle-relative concept path. Returns the canonical
 * path ('findings/use-cases.md') or an error string. Rules: no leading slash
 * stored (links render with the OKF-recommended leading slash), no traversal,
 * conservative segment charset, forced .md suffix, reserved names refused.
 */
export function sanitizeKnowledgePath(raw: string): { path: string } | { error: string } {
	let p = String(raw ?? "").trim().replace(/^\/+/, "");
	if (!p) return { error: "path is required" };
	if (!p.endsWith(".md")) p = `${p}.md`;
	if (p.length > KNOWLEDGE_MAX_PATH_LENGTH) {
		return { error: `path exceeds ${KNOWLEDGE_MAX_PATH_LENGTH} chars` };
	}
	const segments = p.split("/");
	for (const seg of segments) {
		if (!SEGMENT_RE.test(seg) || seg === "." || seg === "..") {
			return {
				error: `invalid path segment '${seg}' — use letters, digits, '.', '_', '-' and '/' separators`,
			};
		}
	}
	if (RESERVED_BASENAMES.has(segments[segments.length - 1])) {
		return { error: "index.md and log.md are reserved — the platform generates them" };
	}
	return { path: p };
}

/** YAML scalar via JSON string encoding — valid YAML, no injection surface. */
function yamlScalar(value: string): string {
	return JSON.stringify(value);
}

function isoTimestamp(raw: string): string {
	const d = new Date(raw);
	return Number.isFinite(d.getTime()) ? d.toISOString() : String(raw);
}

/** One concept document: frontmatter + body. */
export function renderConcept(row: {
	type: string;
	title: string | null;
	description: string | null;
	tags: string[];
	updated_at: string;
	body: string;
}): string {
	const lines = ["---", `type: ${yamlScalar(row.type)}`];
	if (row.title) lines.push(`title: ${yamlScalar(row.title)}`);
	if (row.description) lines.push(`description: ${yamlScalar(row.description)}`);
	if (Array.isArray(row.tags) && row.tags.length > 0) {
		lines.push(`tags: [${row.tags.map((t) => yamlScalar(String(t))).join(", ")}]`);
	}
	lines.push(`timestamp: ${yamlScalar(isoTimestamp(row.updated_at))}`, "---", "");
	const body = String(row.body ?? "").trim();
	return `${lines.join("\n")}${body ? `${body}\n` : ""}`;
}

/** Root index.md: okf_version declaration + type-grouped concept listing. */
export function renderIndex(
	teamName: string,
	entries: TeamKnowledgeIndexEntry[],
): string {
	const byType = new Map<string, TeamKnowledgeIndexEntry[]>();
	for (const e of entries) {
		const list = byType.get(e.type) ?? [];
		list.push(e);
		byType.set(e.type, list);
	}
	const lines = [
		"---",
		`okf_version: ${yamlScalar(OKF_VERSION)}`,
		"---",
		"",
		`# ${teamName} — team knowledge`,
		"",
	];
	for (const [type, list] of [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		lines.push(`## ${type}`, "");
		for (const e of list) {
			const label = e.title || e.path;
			lines.push(`- [${label}](/${e.path})${e.description ? ` — ${e.description}` : ""}`);
		}
		lines.push("");
	}
	if (entries.length === 0) lines.push("_No concepts published yet._", "");
	return lines.join("\n");
}

/** log.md: newest-first, ISO-8601 date headings, one line per revision. */
export function renderLog(entries: TeamKnowledgeIndexEntry[]): string {
	const sorted = [...entries].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
	const lines = ["# Log", ""];
	let currentDay = "";
	for (const e of sorted) {
		const iso = isoTimestamp(e.updated_at);
		const day = iso.slice(0, 10);
		if (day !== currentDay) {
			lines.push(`## ${day}`, "");
			currentDay = day;
		}
		const verb = e.created_at === e.updated_at ? "**Creation**" : "**Update**";
		lines.push(`- ${verb} [${e.title || e.path}](/${e.path})`);
	}
	if (sorted.length === 0) lines.push("_Empty._");
	lines.push("");
	return lines.join("\n");
}

export type OkfBundleFile = { path: string; content: string };

/** The whole bundle: index.md + log.md + every concept, ready to tar/commit. */
export function renderBundle(
	teamName: string,
	index: TeamKnowledgeIndexEntry[],
	concepts: TeamKnowledgeRow[],
): OkfBundleFile[] {
	return [
		{ path: "index.md", content: renderIndex(teamName, index) },
		{ path: "log.md", content: renderLog(index) },
		...concepts.map((c) => ({ path: c.path, content: renderConcept(c) })),
	];
}
