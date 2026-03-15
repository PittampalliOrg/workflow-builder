import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { getWorkflowOrchestratorUrl } from "@/lib/config-service";
import { allowAnonymousDaprDebug } from "@/lib/dapr/debug-access";
import { daprDashboardClient } from "@/lib/dapr/dashboard-client";
import type {
	DaprDebugAppDetailResponse,
	DaprRuntimeIntrospection,
} from "@/lib/types/dapr-debug";

const DURABLE_AGENT_API_BASE_URL =
	process.env.DURABLE_AGENT_API_BASE_URL ||
	"http://durable-agent.workflow-builder.svc.cluster.local:8001";

function buildErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function fetchServiceIntrospection(
	url: string,
): Promise<DaprRuntimeIntrospection> {
	const response = await fetch(url, {
		headers: {
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(5000),
		cache: "no-store",
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
		);
	}
	return (await response.json()) as DaprRuntimeIntrospection;
}

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ appId: string }> },
) {
	const session = await getSession(request);
	if (!session?.user && !allowAnonymousDaprDebug()) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { appId } = await params;
	const response: DaprDebugAppDetailResponse = {
		appId,
		sourceStatus: {
			dashboard: { ok: false, error: "Dashboard not queried" },
			introspection: { ok: false, error: "Introspection not queried" },
		},
		instance: null,
		metadata: null,
		introspection: null,
	};

	try {
		const dashboardBaseUrl = await daprDashboardClient.resolveBaseUrl();
		const instances = await daprDashboardClient.getInstances(
			"workflow-builder",
			dashboardBaseUrl,
		);
		const instance = instances.find((item) => item.appId === appId) ?? null;
		response.instance = instance;
		response.metadata = instance
			? await daprDashboardClient.getMetadata(
					"workflow-builder",
					appId,
					dashboardBaseUrl,
				)
			: null;
		response.sourceStatus.dashboard = { ok: true };
	} catch (error) {
		response.sourceStatus.dashboard = {
			ok: false,
			error: buildErrorMessage(error),
		};
	}

	try {
		if (appId === "workflow-orchestrator") {
			const orchestratorUrl = await getWorkflowOrchestratorUrl();
			response.introspection = await fetchServiceIntrospection(
				`${orchestratorUrl.replace(/\/+$/, "")}/api/v2/runtime/introspect`,
			);
			response.sourceStatus.introspection = { ok: true };
		} else if (appId === "durable-agent") {
			response.introspection = await fetchServiceIntrospection(
				`${DURABLE_AGENT_API_BASE_URL.replace(/\/+$/, "")}/api/runtime/introspect`,
			);
			response.sourceStatus.introspection = { ok: true };
		} else {
			response.sourceStatus.introspection = {
				ok: false,
				error: "No service introspection endpoint for this app",
			};
		}
	} catch (error) {
		response.sourceStatus.introspection = {
			ok: false,
			error: buildErrorMessage(error),
		};
	}

	return NextResponse.json(response, {
		headers: {
			"Cache-Control": "no-store",
		},
	});
}
