import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import {
	workflowAiMessages,
	workflowAiToolMessages,
	workflows,
} from "@/lib/db/schema";
import { isWorkflowAiMessagesTableMissing } from "@/lib/db/workflow-ai-messages";
import { isWorkflowAiToolMessagesTableMissing } from "@/lib/db/workflow-ai-tool-messages";

export async function DELETE(
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

		let legacyDeleted = 0;
		let toolsDeleted = 0;

		try {
			const deleted = await db
				.delete(workflowAiMessages)
				.where(
					and(
						eq(workflowAiMessages.workflowId, workflowId),
						eq(workflowAiMessages.userId, session.user.id),
					),
				)
				.returning({ id: workflowAiMessages.id });
			legacyDeleted = deleted.length;
		} catch (error) {
			if (!isWorkflowAiMessagesTableMissing(error)) {
				throw error;
			}
		}

		try {
			const deleted = await db
				.delete(workflowAiToolMessages)
				.where(
					and(
						eq(workflowAiToolMessages.workflowId, workflowId),
						eq(workflowAiToolMessages.userId, session.user.id),
					),
				)
				.returning({ id: workflowAiToolMessages.id });
			toolsDeleted = deleted.length;
		} catch (error) {
			if (!isWorkflowAiToolMessagesTableMissing(error)) {
				throw error;
			}
		}

		return NextResponse.json({
			success: true,
			deleted: {
				legacyMessages: legacyDeleted,
				toolMessages: toolsDeleted,
			},
		});
	} catch (error) {
		console.error("Failed to clear workflow AI chat history:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to clear workflow AI chat history",
			},
			{ status: 500 },
		);
	}
}
