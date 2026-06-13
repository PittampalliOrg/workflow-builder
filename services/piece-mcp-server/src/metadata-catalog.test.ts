import { describe, expect, it } from "vitest";
import {
	CATALOG_SCHEMA_VERSION,
	buildPieceCatalogRows,
	validateCatalogMetadata,
} from "./metadata-catalog";
import { getPiece } from "./piece-registry";

const expectedActions: Record<string, string> = {
	"microsoft-todo": "create_task",
	"microsoft-outlook": "send-email",
	"google-calendar": "create_google_calendar_event",
	github: "github_create_issue",
	openai: "ask_chatgpt",
};

describe("metadata catalog generation", () => {
	it("generates canonical metadata for representative AP pieces", () => {
		const rows = buildPieceCatalogRows({
			pieceNames: [
				"microsoft-todo",
				"microsoft-outlook",
				"microsoft-onedrive",
				"google-calendar",
				"github",
				"openai",
			],
			sourceImage: "piece-mcp-server:test",
		});
		const byName = new Map(rows.map((row) => [row.name, row]));

		for (const pieceName of [
			"microsoft-todo",
			"microsoft-outlook",
			"microsoft-onedrive",
			"google-calendar",
			"github",
			"openai",
		]) {
			const row = byName.get(pieceName);
			expect(row, pieceName).toBeDefined();
			expect(row?.catalogSchemaVersion).toBe(CATALOG_SCHEMA_VERSION);
			expect(row?.catalogDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(Object.keys(row?.actions ?? {}).length).toBeGreaterThan(0);
		}

		for (const [pieceName, actionName] of Object.entries(expectedActions)) {
			const action = byName.get(pieceName)?.actions[actionName];
			expect(action, `${pieceName}/${actionName}`).toBeDefined();
			expect(Object.keys(action?.inputSchema.properties ?? {}).length).toBeGreaterThan(0);
			expect(action?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		}
	});

	it("rejects legacy metadata without canonical input schemas", async () => {
		const piece = await getPiece("microsoft-todo");
		if (!piece) throw new Error("microsoft-todo piece is not registered");
		const [row] = buildPieceCatalogRows({ pieceNames: ["microsoft-todo"] });
		const actions = { ...row.actions };
		actions.create_task = {
			...actions.create_task,
			inputSchema: undefined,
		} as never;

		expect(() =>
			validateCatalogMetadata({
				pieceName: "microsoft-todo",
				piece,
				row: {
					actions,
					catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
					catalogDigest: row.catalogDigest,
				},
			}),
		).toThrow(/missing inputSchema/);
	});
});
