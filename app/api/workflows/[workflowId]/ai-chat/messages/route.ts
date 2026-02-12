import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { workflowAiMessages, workflows } from "@/lib/db/schema";
import { isWorkflowAiMessagesTableMissing } from "@/lib/db/workflow-ai-messages";

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

		let messages: Array<{
			id: string;
			role: "user" | "assistant" | "system";
			content: string;
			operations: Array<Record<string, unknown>> | null;
			createdAt: Date;
			updatedAt: Date;
		}> = [];

		try {
			messages = await db
				.select({
					id: workflowAiMessages.id,
					role: workflowAiMessages.role,
					content: workflowAiMessages.content,
					operations: workflowAiMessages.operations,
					createdAt: workflowAiMessages.createdAt,
					updatedAt: workflowAiMessages.updatedAt,
				})
				.from(workflowAiMessages)
				.where(
					and(
						eq(workflowAiMessages.workflowId, workflowId),
						eq(workflowAiMessages.userId, session.user.id),
					),
				)
				.orderBy(asc(workflowAiMessages.createdAt));
		} catch (error) {
			if (isWorkflowAiMessagesTableMissing(error)) {
				console.warn(
					"[AI Chat] workflow_ai_messages table missing. Returning empty history.",
				);
			} else {
				throw error;
			}
		}

		return NextResponse.json({
			messages: messages.map((message) => ({
				...message,
				createdAt: message.createdAt.toISOString(),
				updatedAt: message.updatedAt.toISOString(),
			})),
		});
	} catch (error) {
		console.error("Failed to load workflow AI messages:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to load workflow AI messages",
			},
			{ status: 500 },
		);
	}
}
