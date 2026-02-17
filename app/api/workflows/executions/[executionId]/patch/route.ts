import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { invokeService } from "@/lib/dapr/client";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";

const DURABLE_AGENT_APP_ID =
	process.env.DURABLE_AGENT_APP_ID || "durable-agent";

function shouldMarkPending(status: string): boolean {
	return status === "pending" || status === "running";
}

type ExecutionPatchResponse = {
	success?: boolean;
	executionId?: string;
	durableInstanceId?: string;
	patch?: string;
	changeSets?: unknown[];
	pending?: boolean;
	error?: string;
};

function errorMessage(data: unknown, fallback: string): string {
	if (!data || typeof data !== "object") {
		return fallback;
	}
	const candidate = (data as Record<string, unknown>).error;
	return typeof candidate === "string" && candidate.length > 0
		? candidate
		: fallback;
}

export async function GET(
	request: Request,
	context: { params: Promise<{ executionId: string }> },
) {
	try {
		const { executionId } = await context.params;
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const execution = await db.query.workflowExecutions.findFirst({
			where: eq(workflowExecutions.id, executionId),
			with: {
				workflow: true,
			},
		});

		if (!execution) {
			return NextResponse.json(
				{ error: "Execution not found" },
				{ status: 404 },
			);
		}

		if (execution.workflow.userId !== session.user.id) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}

		const url = new URL(request.url);
		const durableInstanceId = url.searchParams.get("durableInstanceId")?.trim();
		const format = url.searchParams.get("format");
		const query =
			durableInstanceId && durableInstanceId.length > 0
				? `?durableInstanceId=${encodeURIComponent(durableInstanceId)}`
				: "";

		const response = await invokeService<ExecutionPatchResponse>({
			appId: DURABLE_AGENT_APP_ID,
			method: "GET",
			path: `/v1.0/invoke/${encodeURIComponent(DURABLE_AGENT_APP_ID)}/method/api/workspaces/executions/${encodeURIComponent(executionId)}/patch${query}`,
			timeout: 20_000,
		});

		if (response.status === 404) {
			const pending = shouldMarkPending(execution.status);
			const pendingPayload = {
				success: true,
				executionId,
				durableInstanceId,
				patch: "",
				changeSets: [],
				pending,
			};
			if (format === "raw") {
				return new Response("", {
					headers: {
						"Content-Type": "text/plain; charset=utf-8",
						"Cache-Control": "no-store",
					},
				});
			}
			return NextResponse.json(pendingPayload, {
				headers: {
					"Cache-Control": "no-store",
				},
			});
		}

		if (!response.ok || !response.data) {
			return NextResponse.json(
				{
					error: errorMessage(response.data, "Failed to fetch execution patch"),
				},
				{ status: response.status || 502 },
			);
		}

		const payload = {
			success: true,
			executionId,
			durableInstanceId,
			patch: response.data.patch ?? "",
			changeSets: response.data.changeSets ?? [],
		};

		if (format === "raw") {
			return new Response(payload.patch, {
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					"Cache-Control": "no-store",
				},
			});
		}

		return NextResponse.json(payload, {
			headers: {
				"Cache-Control": "no-store",
			},
		});
	} catch (error) {
		console.error("Failed to load execution patch:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to load execution patch",
			},
			{ status: 500 },
		);
	}
}
