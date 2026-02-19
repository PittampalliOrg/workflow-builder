import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { workflows, workflowAiToolMessages } from "@/lib/db/schema";
import { isWorkflowAiToolMessagesTableMissing } from "@/lib/db/workflow-ai-tool-messages";

function normalizeMessageParts(
	parts: unknown,
	fallbackText: string,
): Array<Record<string, unknown>> {
	if (Array.isArray(parts) && parts.length > 0) {
		return parts.filter(
			(part) => typeof part === "object" && part !== null,
		) as Array<Record<string, unknown>>;
	}

	if (fallbackText.length > 0) {
		return [{ type: "text", text: fallbackText }];
	}

	return [];
}

export async function GET(
	request: Request,
	context: { params: Promise<{ workflowId: string }> },
) {
	try {
		const { workflowId } = await context.params;
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const workflow = await db.query.workflows.findFirst({
			where: and(
				eq(workflows.id, workflowId),
				eq(workflows.userId, session.user.id),
			),
		});

		if (!workflow) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		let rows: Array<{
			messageId: string;
			role: "user" | "assistant" | "system";
			parts: Array<Record<string, unknown>>;
			textContent: string;
		}> = [];

		try {
			rows = await db
				.select({
					messageId: workflowAiToolMessages.messageId,
					role: workflowAiToolMessages.role,
					parts: workflowAiToolMessages.parts,
					textContent: workflowAiToolMessages.textContent,
				})
				.from(workflowAiToolMessages)
				.where(
					and(
						eq(workflowAiToolMessages.workflowId, workflowId),
						eq(workflowAiToolMessages.userId, session.user.id),
					),
				)
				.orderBy(asc(workflowAiToolMessages.createdAt));
		} catch (error) {
			if (isWorkflowAiToolMessagesTableMissing(error)) {
				console.warn(
					"[AI Chat Tools] workflow_ai_tool_messages table missing. Returning empty history.",
				);
			} else {
				throw error;
			}
		}

		const messages = rows.map((row) => ({
			id: row.messageId,
			role: row.role,
			parts: normalizeMessageParts(row.parts, row.textContent),
		}));

		return NextResponse.json({ messages });
	} catch (error) {
		console.error("Failed to load workflow AI tools chat messages:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to load workflow AI tools chat messages",
			},
			{ status: 500 },
		);
	}
}
