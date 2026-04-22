/**
 * Local smoke test for `ingestSkillBundle` — runs BEFORE we rebuild + deploy
 * so we catch regressions without waiting for the Tekton pipeline. Covers
 * both source branches against real bundles (anthropics/skills on GitHub +
 * the user's crawl4ai zip).
 *
 * Usage (from workflow-builder root):
 *   pnpm tsx scripts/smoke-ingest-skill-bundle.ts
 *
 * Standalone — imports only the ingestion-relevant helpers, NOT the DB
 * module. Skips tsx's `$env/dynamic/private` resolution issue the other
 * seed scripts work around. The actual production code path
 * (`upsertAgentSkillMetadata` / `upsertCustomSkillFromZip`) layers DB
 * writes on top of what this smoke validates.
 */
import { readFileSync } from "node:fs";
import { ingestSkillBundle } from "../src/lib/server/skill-ingest";

async function testGithub() {
	console.log("=== github: anthropics/skills xlsx ===");
	const bundle = await ingestSkillBundle({
		type: "github",
		repo: "anthropics/skills",
		skillName: "xlsx",
		ref: "main",
	});
	console.log(`  prompt len: ${bundle.prompt.length}`);
	console.log(`  frontmatter name: ${bundle.frontmatter.name}`);
	console.log(`  package files: ${bundle.packageFiles.length}`);
	for (const f of bundle.packageFiles.slice(0, 10)) {
		console.log(`    - ${f.path} (${f.content.length} chars)`);
	}
	if (bundle.packageFiles.length > 10) {
		console.log(`    ... +${bundle.packageFiles.length - 10} more`);
	}
	console.log(`  contentHash: ${bundle.contentHash.slice(0, 16)}…`);
	console.log(`  sourceUrl: ${bundle.sourceUrl}`);
	if (bundle.prompt.length === 0) throw new Error("prompt empty — SKILL.md parse failed");
	if (bundle.packageFiles.length === 0) {
		console.warn("  !! warning: no package files — expected scripts/ or references/ under the skill dir");
	}
}

async function testZip() {
	const path = "/home/vpittamp/Downloads/crawl4ai-skill.zip";
	console.log(`=== zip: ${path} ===`);
	const buffer = readFileSync(path);
	const bundle = await ingestSkillBundle({
		type: "zip",
		buffer,
		skillName: "crawl4ai",
	});
	console.log(`  prompt len: ${bundle.prompt.length}`);
	console.log(`  frontmatter name: ${bundle.frontmatter.name}`);
	console.log(`  package files: ${bundle.packageFiles.length}`);
	for (const f of bundle.packageFiles) {
		console.log(`    - ${f.path} (${f.content.length} chars)`);
	}
	console.log(`  contentHash: ${bundle.contentHash.slice(0, 16)}…`);
	if (bundle.prompt.length === 0) throw new Error("prompt empty");
	if (bundle.packageFiles.length === 0) throw new Error("expected package files from crawl4ai zip");
}

async function main() {
	try {
		await testGithub();
	} catch (e) {
		console.error("github test failed:", e);
		process.exitCode = 1;
	}
	try {
		await testZip();
	} catch (e) {
		console.error("zip test failed:", e);
		process.exitCode = 1;
	}
}

main();
