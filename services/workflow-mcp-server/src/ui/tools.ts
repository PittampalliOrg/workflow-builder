import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { UiSession } from "./session.js";
import { UiEventSchema } from "./types.js";

type UiMeta = { ui: { resourceUri: string }; "ui/resourceUri": string };

function textResult(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
	};
}

function errorResult(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
	};
}

export function registerUiTools(
	server: McpServer,
	uiSession: UiSession,
	uiMeta: UiMeta,
): void {
	(server as any).registerTool(
		"ui_bootstrap",
		{
			title: "UI Bootstrap",
			description:
				"Initialize the interactive UI state and return Remote DOM mutations from seq=0.",
			inputSchema: {},
			_meta: uiMeta,
		},
		async () => {
			try {
				const { seq, mutations } = await uiSession.bootstrap();
				return textResult({ seq, mutations });
			} catch (err) {
				return errorResult(`Failed to bootstrap UI: ${String(err)}`);
			}
		},
	);

	(server as any).registerTool(
		"ui_updates",
		{
			title: "UI Updates",
			description:
				"Poll for Remote DOM mutation updates since a seq. Used by the interactive UI to stay in sync with server-owned state.",
			inputSchema: {
				since: z
					.number()
					.describe("Last applied UI seq (from ui_bootstrap/ui_updates)"),
			},
			_meta: uiMeta,
		},
		async (args: { since: number }) => {
			try {
				const { seq, mutations, reset } = await uiSession.updates(args.since);
				return textResult({
					seq,
					mutations,
					...(reset ? { reset: true } : {}),
				});
			} catch (err) {
				return errorResult(`Failed to get UI updates: ${String(err)}`);
			}
		},
	);

	(server as any).registerTool(
		"ui_event",
		{
			title: "UI Event",
			description:
				"Send a typed UI action to the server (server-owned UI state). Returns Remote DOM mutations produced by that action.",
			inputSchema: UiEventSchema,
			_meta: uiMeta,
		},
		async (args: unknown) => {
			const parsed = UiEventSchema.safeParse(args);
			if (!parsed.success) {
				return errorResult(
					`Invalid ui_event payload: ${parsed.error.issues
						.map((i) => `${i.path.join(".")}: ${i.message}`)
						.join(", ")}`,
				);
			}
			try {
				const { seq, mutations } = await uiSession.handleEvent(parsed.data);
				return textResult({ ok: true, seq, mutations });
			} catch (err) {
				return textResult({ ok: false, error: { message: String(err) } });
			}
		},
	);
}
