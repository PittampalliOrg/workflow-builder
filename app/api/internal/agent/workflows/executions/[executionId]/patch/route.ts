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

		const url = new URL(request.url);
		const durableInstanceId = url.searchParams.get("durableInstanceId")?.trim();
		const query = durableInstanceId
			? `?durableInstanceId=${encodeURIComponent(durableInstanceId)}`
			: "";

		const response = await invokeService<{
			success?: boolean;
			executionId?: string;
			durableInstanceId?: string;
			patch?: string;
			changeSets?: unknown[];
			pending?: boolean;
			error?: string;
		}>({
			appId: DURABLE_AGENT_APP_ID,
			method: "GET",
			path: `/v1.0/invoke/${encodeURIComponent(DURABLE_AGENT_APP_ID)}/method/api/workspaces/executions/${encodeURIComponent(executionId)}/patch${query}`,
			timeout: 20_000,
		});

		if (response.status === 404) {
			return NextResponse.json(
				{
					success: true,
					executionId,
					durableInstanceId,
					patch: "",
					changeSets: [],
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
					error: errorMessage(response.data, "Failed to fetch execution patch"),
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
		console.error("Failed to fetch internal execution patch:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to fetch execution patch",
			},
			{ status: 500 },
		);
	}
}
