/**
 * Re-ingest `crawl4ai`, `xlsx`, `pptx` through the standardized pipeline
 * (`POST /api/admin/agent-skills/import` + `POST /api/admin/agent-skills/import/zip`).
 *
 * Run inside the workflow-builder pod where the BFF is reachable at
 * localhost:3000. Signs in as the dev admin (admin@example.com/developer)
 * and drives the same endpoints an operator would click through.
 *
 * Usage:
 *   pnpm tsx scripts/reingest-skills.ts
 *   pnpm tsx scripts/reingest-skills.ts --only=crawl4ai
 *   pnpm tsx scripts/reingest-skills.ts --zip-path=/tmp/crawl4ai-skill.zip
 *
 * Assertion: after each ingest, queries the DB to confirm
 * `jsonb_array_length(package_manifest->'files') > 0`. Fails loudly if the
 * caps dropped everything — that's the signal that the source bundle
 * exceeds the 40/64KiB/256KiB caps in agent-skills.ts.
 */

import { readFileSync } from "node:fs";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error("DATABASE_URL not set");
	process.exit(1);
}
const BFF = process.env.WORKFLOW_BUILDER_URL ?? "http://localhost:3000";

type Args = { only: string | null; zipPath: string; workspace: string };
function parseArgs(argv: string[]): Args {
	let only: string | null = null;
	let zipPath = "/home/vpittamp/Downloads/crawl4ai-skill.zip";
	let workspace = "default";
	for (const a of argv.slice(2)) {
		if (a.startsWith("--only=")) only = a.slice(7).trim() || null;
		else if (a.startsWith("--zip-path=")) zipPath = a.slice(11).trim() || zipPath;
		else if (a.startsWith("--workspace=")) workspace = a.slice(12).trim() || workspace;
	}
	return { only, zipPath, workspace };
}

async function signIn(): Promise<string> {
	const res = await fetch(`${BFF}/api/v1/auth/sign-in`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: "admin@example.com", password: "developer" }),
	});
	if (!res.ok) throw new Error(`sign-in failed ${res.status}: ${await res.text()}`);
	return res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");
}

async function importFromGithub(
	cookie: string,
	workspace: string,
	skillName: string,
	installSource = "anthropics/skills",
) {
	const res = await fetch(`${BFF}/api/admin/agent-skills/import`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			cookie,
			"x-workspace": workspace,
		},
		body: JSON.stringify({ installSource, skillName, status: "ENABLED" }),
	});
	const body = await res.text();
	if (!res.ok) throw new Error(`import ${skillName} failed ${res.status}: ${body}`);
	return JSON.parse(body) as { skill: { slug: string; id: string } };
}

async function importFromZip(
	cookie: string,
	workspace: string,
	zipPath: string,
	skillName: string,
	slug?: string,
) {
	const form = new FormData();
	const buf = readFileSync(zipPath);
	form.append("file", new Blob([new Uint8Array(buf)]), zipPath.split("/").pop() ?? "bundle.zip");
	form.append("skillName", skillName);
	if (slug) form.append("slug", slug);
	form.append("status", "ENABLED");
	const res = await fetch(`${BFF}/api/admin/agent-skills/import/zip`, {
		method: "POST",
		headers: { cookie, "x-workspace": workspace },
		body: form,
	});
	const body = await res.text();
	if (!res.ok) throw new Error(`zip import failed ${res.status}: ${body}`);
	return JSON.parse(body) as { skill: { slug: string; id: string } };
}

async function assertFilesPopulated(
	sql: ReturnType<typeof postgres>,
	slug: string,
): Promise<number> {
	const rows = await sql<{ n: number }[]>`
		SELECT COALESCE(jsonb_array_length(package_manifest->'files'), 0)::int AS n
		FROM agent_skill_registry WHERE slug = ${slug} LIMIT 1
	`;
	const n = rows[0]?.n ?? 0;
	if (n <= 0) {
		throw new Error(
			`Re-ingest for slug=${slug} landed with empty package_manifest.files — check caps.`,
		);
	}
	return n;
}

async function main() {
	const args = parseArgs(process.argv);
	const sql = postgres(DATABASE_URL!, { max: 1 });
	try {
		console.log(`[reingest] signing in at ${BFF} …`);
		const cookie = await signIn();

		// xlsx
		if (!args.only || args.only === "xlsx") {
			console.log("[reingest] importing xlsx from anthropics/skills …");
			const r = await importFromGithub(cookie, args.workspace, "xlsx");
			const n = await assertFilesPopulated(sql, r.skill.slug);
			console.log(`  ✓ xlsx (slug=${r.skill.slug}) → ${n} package files`);
		}

		// pptx
		if (!args.only || args.only === "pptx") {
			console.log("[reingest] importing pptx from anthropics/skills …");
			const r = await importFromGithub(cookie, args.workspace, "pptx");
			const n = await assertFilesPopulated(sql, r.skill.slug);
			console.log(`  ✓ pptx (slug=${r.skill.slug}) → ${n} package files`);
		}

		// crawl4ai (from the user-provided zip)
		if (!args.only || args.only === "crawl4ai") {
			console.log(`[reingest] importing crawl4ai from zip ${args.zipPath} …`);
			// The existing crawl4ai row is workspace-scoped (sourceType='custom').
			// upsertCustomSkillFromZip UPSERTs by slug, bumping the version. If
			// the previous insert used a different slug (e.g., 'crawl4ai' vs
			// 'zip-crawl4ai-crawl4ai'), pass --slug-hint explicitly via env.
			const r = await importFromZip(cookie, args.workspace, args.zipPath, "crawl4ai", "crawl4ai");
			const n = await assertFilesPopulated(sql, r.skill.slug);
			console.log(`  ✓ crawl4ai (slug=${r.skill.slug}) → ${n} package files`);
		}

		console.log("[reingest] done");
	} finally {
		await sql.end();
	}
}

main().catch((e) => {
	console.error("fatal:", e);
	process.exit(1);
});
