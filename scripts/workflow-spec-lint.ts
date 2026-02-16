/**
 * WorkflowSpec Lint Script
 *
 * Usage:
 *   pnpm tsx scripts/workflow-spec-lint.ts <file1.json> [file2.json...]
 */

import { readFile } from "node:fs/promises";
import process from "node:process";
import { convertApPiecesToIntegrations } from "@/lib/activepieces/action-adapter";
import { isPieceInstalled } from "@/lib/activepieces/installed-pieces";
import { getBuiltinPieces } from "@/lib/actions/builtin-pieces";
import { listPieceMetadata } from "@/lib/db/piece-metadata";
import { buildCatalogFromIntegrations } from "@/lib/workflow-spec/catalog";
import { lintWorkflowSpec } from "@/lib/workflow-spec/lint";
import { getSystemWorkflowSpecActions } from "@/lib/workflow-spec/system-actions";

async function main() {
	const files = process.argv.slice(2).filter((a) => !a.startsWith("-"));
	if (files.length === 0) {
		console.error(
			"Usage: pnpm tsx scripts/workflow-spec-lint.ts <file.json>...",
		);
		process.exit(2);
	}

	const builtinPieces = getBuiltinPieces();
	let integrations = builtinPieces;
	try {
		const allMetadata = await listPieceMetadata({});
		const apPieces = convertApPiecesToIntegrations(allMetadata).filter(
			(piece) => isPieceInstalled(piece.pieceName || piece.type),
		);
		integrations = [...builtinPieces, ...apPieces];
	} catch (error) {
		console.warn(
			"[workflow:lint] Failed to load Activepieces catalog from DB; linting with builtin catalog only.",
			error instanceof Error ? error.message : error,
		);
	}

	const catalog = buildCatalogFromIntegrations(integrations);
	catalog.integrationLabels.system = "System";
	for (const action of getSystemWorkflowSpecActions()) {
		catalog.actionsById.set(action.id, action);
	}
	// Note: this script intentionally lints against the same catalog the UI uses
	// (installed Activepieces pieces + builtin pieces). Plugin registry actions
	// are not imported here to avoid server/client component boundary issues.

	let hadErrors = false;
	for (const file of files) {
		const raw = await readFile(file, "utf-8");
		const json = JSON.parse(raw) as unknown;
		const { result } = lintWorkflowSpec(json, {
			catalog,
			unknownActionType: "warn",
		});

		if (result.errors.length > 0) {
			hadErrors = true;
			console.error(`\n${file}: ${result.errors.length} errors`);
			for (const e of result.errors) {
				console.error(`  [${e.code}] ${e.path}: ${e.message}`);
			}
		}

		if (result.warnings.length > 0) {
			console.warn(`\n${file}: ${result.warnings.length} warnings`);
			for (const w of result.warnings) {
				console.warn(`  [${w.code}] ${w.path}: ${w.message}`);
			}
		}

		if (result.errors.length === 0 && result.warnings.length === 0) {
			console.log(`${file}: ok`);
		}
	}

	process.exit(hadErrors ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
