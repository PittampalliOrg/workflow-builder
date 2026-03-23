import { NextResponse } from "next/server";
import { invokeService } from "@/lib/dapr/client";
import { isValidInternalToken } from "@/lib/internal-api";

const DURABLE_AGENT_APP_ID =
	process.env.DURABLE_AGENT_APP_ID || "durable-agent";

function errorMessage(data: unknown, fallback: string): string {
	if (!data || typeof data !== "object") {
		return fallback;
	}
	const candidate = (data as Record<string, unknown>).error;
	return typeof candidate === "string" && candidate.length > 0
		? candidate
		: fallback;
}

async function forwardExecutionChanges(executionId: string) {
	return await invokeService<{
		success?: boolean;
		executionId?: string;
		count?: number;
		changes?: unknown[];
		pending?: boolean;
		error?: string;
	}>({
		appId: DURABLE_AGENT_APP_ID,
		method: "GET",
		path: `/v1.0/invoke/${encodeURIComponent(DURABLE_AGENT_APP_ID)}/method/api/workspaces/executions/${encodeURIComponent(executionId)}/changes`,
		timeout: 20_000,
	});
}

export async function GET(
	request: Request,
	context: { params: Promise<{ executionId: string }> },
) {
	if (!isValidInternalToken(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		const { executionId } = await context.params;
		if (!executionId?.trim()) {
			return NextResponse.json(
				{ error: "Execution ID is required" },
				{ status: 400 },
			);
		}

		const response = await forwardExecutionChanges(executionId);
		if (response.status === 404) {
			return NextResponse.json(
				{
					success: true,
					executionId,
					count: 0,
					changes: [],
					pending: false,
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
						"Failed to fetch execution change artifacts",
					),
				},
				{ status: response.status || 502 },
			);
		}

		return NextResponse.json(response.data, {
			headers: {
				"Cache-Control": "no-store",
			},
		});
	} catch (error) {
		console.error("Failed to fetch internal execution changes:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to fetch execution change artifacts",
			},
			{ status: 500 },
		);
	}
}

export async function POST(
	request: Request,
	context: { params: Promise<{ executionId: string }> },
) {
	if (!isValidInternalToken(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		const { executionId } = await context.params;
		if (!executionId?.trim()) {
			return NextResponse.json(
				{ error: "Execution ID is required" },
				{ status: 400 },
			);
		}

		const body = await request.json().catch(() => null);
		if (!body || typeof body !== "object") {
			return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
		}

		const response = await invokeService<{
			success?: boolean;
			change?: unknown;
			error?: string;
		}>({
			appId: DURABLE_AGENT_APP_ID,
			method: "POST",
			path: `/v1.0/invoke/${encodeURIComponent(DURABLE_AGENT_APP_ID)}/method/api/workspaces/executions/${encodeURIComponent(executionId)}/change-artifacts`,
			body,
			timeout: 20_000,
		});

		if (!response.ok || !response.data) {
			return NextResponse.json(
				{
					error: errorMessage(
						response.data,
						"Failed to persist execution change artifact",
					),
				},
				{ status: response.status || 502 },
			);
		}

		return NextResponse.json(response.data, {
			headers: {
				"Cache-Control": "no-store",
			},
		});
	} catch (error) {
		console.error(
			"Failed to persist internal execution change artifact:",
			error,
		);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to persist execution change artifact",
			},
			{ status: 500 },
		);
	}
}
