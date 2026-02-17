import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { invokeService } from "@/lib/dapr/client";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";

const DURABLE_AGENT_APP_ID =
	process.env.DURABLE_AGENT_APP_ID || "durable-agent";

type ExecutionFileSnapshotResponse = {
	success?: boolean;
	executionId?: string;
	path?: string;
	durableInstanceId?: string;
	snapshot?: unknown | null;
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
	context: {
		params: Promise<{ executionId: string; path: string[] }>;
	},
) {
	try {
		const { executionId, path } = await context.params;
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

		const filePath = Array.isArray(path)
			? path
					.map((part) => part.trim())
					.filter(Boolean)
					.join("/")
			: "";
		if (!filePath) {
			return NextResponse.json(
				{ error: "File path is required" },
				{ status: 400 },
			);
		}

		const url = new URL(request.url);
		const durableInstanceId = url.searchParams.get("durableInstanceId")?.trim();
		const query = new URLSearchParams();
		query.set("path", filePath);
		if (durableInstanceId) {
			query.set("durableInstanceId", durableInstanceId);
		}

		const response = await invokeService<ExecutionFileSnapshotResponse>({
			appId: DURABLE_AGENT_APP_ID,
			method: "GET",
			path: `/v1.0/invoke/${encodeURIComponent(DURABLE_AGENT_APP_ID)}/method/api/workspaces/executions/${encodeURIComponent(executionId)}/files/snapshot?${query.toString()}`,
			timeout: 20_000,
		});

		// Snapshot rows may be missing for older executions or if the
		// durable-agent image does not yet support snapshot persistence.
		// Degrade gracefully to patch-only rendering in that case.
		if (response.status === 404) {
			return NextResponse.json(
				{
					success: true,
					executionId,
					path: filePath,
					durableInstanceId,
					snapshot: null,
				},
				{
					headers: {
						"Cache-Control": "no-store",
					},
				},
			);
		}

		if (!response.ok || !response.data) {
			return NextResponse.json(
				{
					error: errorMessage(
						response.data,
						"Failed to fetch execution file snapshot",
					),
				},
				{ status: response.status || 502 },
			);
		}

		return NextResponse.json(
			{
				success: true,
				executionId,
				path: filePath,
				durableInstanceId,
				snapshot: response.data.snapshot,
			},
			{
				headers: {
					"Cache-Control": "no-store",
				},
			},
		);
	} catch (error) {
		console.error("Failed to load execution file snapshot:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to load execution file snapshot",
			},
			{ status: 500 },
		);
	}
}
