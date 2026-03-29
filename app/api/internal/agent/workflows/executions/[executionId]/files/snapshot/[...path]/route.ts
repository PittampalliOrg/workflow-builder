import { NextResponse } from "next/server";
import { invokeService } from "@/lib/dapr/client";
import { isValidInternalToken } from "@/lib/internal-api";

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

async function loadSnapshotFromApp(
	appId: string,
	executionId: string,
	filePath: string,
	durableInstanceId?: string,
) {
	const query = new URLSearchParams();
	query.set("path", filePath);
	if (durableInstanceId) {
		query.set("durableInstanceId", durableInstanceId);
	}
	return await invokeService<ExecutionFileSnapshotResponse>({
		appId,
		method: "GET",
		path: `/v1.0/invoke/${encodeURIComponent(appId)}/method/api/workspaces/executions/${encodeURIComponent(executionId)}/files/snapshot?${query.toString()}`,
		timeout: 20_000,
	});
}

export async function GET(
	request: Request,
	context: {
		params: Promise<{ executionId: string; path: string[] }>;
	},
) {
	if (!isValidInternalToken(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		const { executionId, path } = await context.params;
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
		const response = await loadSnapshotFromApp(
			DURABLE_AGENT_APP_ID,
			executionId,
			filePath,
			durableInstanceId || undefined,
		);

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
		console.error("Failed to load internal execution file snapshot:", error);
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
