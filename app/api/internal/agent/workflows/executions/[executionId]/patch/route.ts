import { NextResponse } from "next/server";
import { invokeService } from "@/lib/dapr/client";
import { isValidInternalToken } from "@/lib/internal-api";

const DURABLE_AGENT_APP_ID =
	process.env.DURABLE_AGENT_APP_ID || "durable-agent";
const DAPR_AGENT_APP_ID = process.env.DAPR_AGENT_APP_ID || "dapr-agent-runtime";

function errorMessage(data: unknown, fallback: string): string {
	if (!data || typeof data !== "object") {
		return fallback;
	}
	const candidate = (data as Record<string, unknown>).error;
	return typeof candidate === "string" && candidate.length > 0
		? candidate
		: fallback;
}

async function loadPatchFromApp(
	appId: string,
	executionId: string,
	durableInstanceId?: string,
) {
	const query = durableInstanceId
		? `?durableInstanceId=${encodeURIComponent(durableInstanceId)}`
		: "";
	return await invokeService<{
		success?: boolean;
		executionId?: string;
		durableInstanceId?: string;
		patch?: string;
		changeSets?: unknown[];
		pending?: boolean;
		error?: string;
	}>({
		appId,
		method: "GET",
		path: `/v1.0/invoke/${encodeURIComponent(appId)}/method/api/workspaces/executions/${encodeURIComponent(executionId)}/patch${query}`,
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

		const url = new URL(request.url);
		const durableInstanceId = url.searchParams.get("durableInstanceId")?.trim();
		const query = durableInstanceId
			? `?durableInstanceId=${encodeURIComponent(durableInstanceId)}`
			: "";

		const response = await loadPatchFromApp(
			DURABLE_AGENT_APP_ID,
			executionId,
			durableInstanceId || undefined,
		);

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

		let responseData = response.data;
		if (
			response.ok &&
			responseData &&
			typeof responseData.patch === "string" &&
			responseData.patch.trim().length === 0
		) {
			const fallback = await loadPatchFromApp(
				DAPR_AGENT_APP_ID,
				executionId,
				durableInstanceId || undefined,
			);
			if (fallback.ok && fallback.data) {
				responseData = fallback.data;
			}
		}

		if (!response.ok || !responseData) {
			return NextResponse.json(
				{
					error: errorMessage(response.data, "Failed to fetch execution patch"),
				},
				{ status: response.status || 502 },
			);
		}

		return NextResponse.json(responseData, {
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
