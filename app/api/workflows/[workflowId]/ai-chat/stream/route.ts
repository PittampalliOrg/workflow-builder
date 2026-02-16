import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { createWorkflowOperationStream } from "@/lib/ai/workflow-generation";
import type { Operation } from "@/lib/ai/validated-operation-stream";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { workflowAiMessages, workflows } from "@/lib/db/schema";
import { isWorkflowAiMessagesTableMissing } from "@/lib/db/workflow-ai-messages";
import { createValidatedOperationStream } from "@/lib/ai/validated-operation-stream";

type ExistingWorkflow = {
	nodes?: Array<{ id: string; data?: { label?: string } }>;
	edges?: Array<{ id: string; source: string; target: string }>;
	name?: string;
};

function summarizeOperations(operations: Operation[]): string {
	if (operations.length === 0) {
		return "I could not produce any workflow operations for that request.";
	}

	const counts = operations.reduce<Record<string, number>>((acc, operation) => {
		acc[operation.op] = (acc[operation.op] || 0) + 1;
		return acc;
	}, {});

	const parts = Object.entries(counts)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, count]) => `${count} ${name}`)
		.join(", ");

	return `Applied ${operations.length} workflow operations: ${parts}.`;
}

export async function POST(
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

		const body = await request.json();
		const message =
			typeof body?.message === "string" ? body.message.trim() : "";
		const existingWorkflow =
			typeof body?.existingWorkflow === "object" && body.existingWorkflow
				? (body.existingWorkflow as ExistingWorkflow)
				: undefined;
		const mode =
			body?.mode === "classic" || body?.mode === "validated"
				? (body.mode as "classic" | "validated")
				: "validated";

		if (!message) {
			return NextResponse.json(
				{ error: "Message is required" },
				{ status: 400 },
			);
		}

		let persistenceAvailable = true;
		try {
			await db.insert(workflowAiMessages).values({
				workflowId,
				userId: session.user.id,
				role: "user",
				content: message,
				operations: null,
			});
		} catch (error) {
			if (isWorkflowAiMessagesTableMissing(error)) {
				persistenceAvailable = false;
				console.warn(
					"[AI Chat] workflow_ai_messages table missing. Proceeding without persistence.",
				);
			} else {
				throw error;
			}
		}

		let recentMessages: Array<{
			role: "user" | "assistant" | "system";
			content: string;
		}> = [];
		if (persistenceAvailable) {
			try {
				recentMessages = await db
					.select({
						role: workflowAiMessages.role,
						content: workflowAiMessages.content,
					})
					.from(workflowAiMessages)
					.where(
						and(
							eq(workflowAiMessages.workflowId, workflowId),
							eq(workflowAiMessages.userId, session.user.id),
						),
					)
					.orderBy(desc(workflowAiMessages.createdAt))
					.limit(20);
			} catch (error) {
				if (isWorkflowAiMessagesTableMissing(error)) {
					persistenceAvailable = false;
					console.warn(
						"[AI Chat] workflow_ai_messages table missing while loading history.",
					);
				} else {
					throw error;
				}
			}
		}

		const messageHistory = recentMessages.reverse();
		const lastHistoryItem = messageHistory.at(-1);
		if (
			lastHistoryItem?.role === "user" &&
			lastHistoryItem.content === message
		) {
			messageHistory.pop();
		}

		const operations: Operation[] = [];
		let streamError: string | null = null;
		const baseStream = await createWorkflowOperationStream({
			prompt: message,
			existingWorkflow,
			messageHistory: messageHistory.map((item) => ({
				role: item.role,
				content: item.content,
			})),
		});

		const sourceStream = await createValidatedOperationStream({
			baseStream,
			prompt: message,
			existingWorkflow,
			mode,
			onOperation: (op) => operations.push(op),
			onError: (err) => {
				streamError = err;
			},
		});

		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const reader = sourceStream.getReader();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							break;
						}
						controller.enqueue(value);
					}

					if (persistenceAvailable) {
						try {
							await db.insert(workflowAiMessages).values({
								workflowId,
								userId: session.user.id,
								role: "assistant",
								content: streamError
									? `Workflow generation failed: ${streamError}`
									: summarizeOperations(operations),
								operations: operations as Array<Record<string, unknown>>,
							});
						} catch (error) {
							if (isWorkflowAiMessagesTableMissing(error)) {
								persistenceAvailable = false;
							} else {
								throw error;
							}
						}
					}
				} catch (error) {
					console.error("Workflow AI chat stream failed:", error);
					if (persistenceAvailable) {
						try {
							await db.insert(workflowAiMessages).values({
								workflowId,
								userId: session.user.id,
								role: "assistant",
								content:
									error instanceof Error
										? `Workflow generation failed: ${error.message}`
										: "Workflow generation failed.",
								operations: operations as Array<Record<string, unknown>>,
							});
						} catch (persistError) {
							if (!isWorkflowAiMessagesTableMissing(persistError)) {
								console.error(
									"[AI Chat] Failed to persist assistant error message:",
									persistError,
								);
							}
						}
					}
				} finally {
					reader.releaseLock();
					controller.close();
				}
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "application/x-ndjson",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("Failed to start workflow AI chat stream:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to start workflow AI chat stream",
			},
			{ status: 500 },
		);
	}
}
