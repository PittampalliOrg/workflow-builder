export type WorkflowApprovalRequestedData = {
	workflowId?: string;
	executionId?: string;
	nodeId?: string;
	nodeName?: string;
	eventName?: string;
	timeoutSeconds?: number;
	expiresAt?: string;
	timestamp?: string;
};

export type WorkflowEventEnvelope = {
	type?: string;
	source?: string;
	time?: string;
	traceId?: string;
	traceparent?: string;
	data?: WorkflowApprovalRequestedData;
};

export type NotificationReceiver = {
	name: string;
	url: string;
	method?: string;
	timeoutSeconds?: number;
	headers?: Record<string, string>;
	enabled?: boolean;
};

type NotificationDeliveryState = {
	dedupeKey: string;
	deliveredReceivers: string[];
	lastAttemptAt: string;
};

type DeliveryResult = {
	delivered: string[];
	skipped: string[];
	failures: Array<{ receiver: string; error: string }>;
};

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PUBSUB_NAME = "pubsub";
const DEFAULT_WORKFLOW_EVENTS_TOPIC = "workflow.events";
const DEFAULT_STATE_STORE = "workflowstatestore";

export function getServerConfig() {
	return {
		port: Number.parseInt(process.env.PORT || `${DEFAULT_PORT}`, 10),
		host: process.env.HOST || DEFAULT_HOST,
		pubsubName: process.env.PUBSUB_NAME || DEFAULT_PUBSUB_NAME,
		topic: process.env.WORKFLOW_EVENTS_TOPIC || DEFAULT_WORKFLOW_EVENTS_TOPIC,
		stateStoreName:
			process.env.WORKFLOW_NOTIFIER_STATE_STORE || DEFAULT_STATE_STORE,
		workflowBuilderBaseUrl:
			process.env.WORKFLOW_BUILDER_BASE_URL?.trim() || null,
		daprHttpBaseUrl: `http://${process.env.DAPR_HTTP_HOST || "127.0.0.1"}:${
			process.env.DAPR_HTTP_PORT || "3500"
		}`,
		receiversJson: process.env.WORKFLOW_NOTIFIER_RECEIVERS_JSON || "[]",
	};
}

export function parseReceivers(raw: string): NotificationReceiver[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed
		.filter(
			(item): item is Record<string, unknown> =>
				Boolean(item) && typeof item === "object" && !Array.isArray(item),
		)
		.map((item) => ({
			name: String(item.name || "").trim(),
			url: String(item.url || "").trim(),
			method: String(item.method || "POST")
				.trim()
				.toUpperCase(),
			timeoutSeconds: Number.isFinite(item.timeoutSeconds)
				? Number(item.timeoutSeconds)
				: 5,
			headers:
				item.headers &&
				typeof item.headers === "object" &&
				!Array.isArray(item.headers)
					? Object.fromEntries(
							Object.entries(item.headers as Record<string, unknown>)
								.map(([key, value]) => [key.trim(), String(value)])
								.filter(([key, value]) => Boolean(key) && Boolean(value)),
						)
					: {},
			enabled: item.enabled !== false,
		}))
		.filter((item) => Boolean(item.name) && Boolean(item.url));
}

export function buildApprovalNotificationPayload(
	event: WorkflowEventEnvelope,
	workflowBuilderBaseUrl: string | null,
) {
	const data = event.data || {};
	const executionId = String(data.executionId || "").trim() || null;
	const workflowId = String(data.workflowId || "").trim() || null;
	const runUrl =
		workflowBuilderBaseUrl && workflowId && executionId
			? `${workflowBuilderBaseUrl.replace(/\/+$/, "")}/workflows/${encodeURIComponent(
					workflowId,
				)}/runs/${encodeURIComponent(executionId)}`
			: null;
	return {
		type: "workflow.approval.requested",
		source: event.source || "workflow-orchestrator",
		traceId: event.traceId || null,
		traceparent: event.traceparent || null,
		workflowId,
		executionId,
		nodeId: String(data.nodeId || "").trim() || null,
		nodeName: String(data.nodeName || "").trim() || null,
		eventName: String(data.eventName || "").trim() || null,
		timeoutSeconds:
			typeof data.timeoutSeconds === "number" ? data.timeoutSeconds : null,
		expiresAt: String(data.expiresAt || "").trim() || null,
		timestamp: String(data.timestamp || event.time || "").trim() || null,
		runUrl,
	};
}

export function approvalNotificationStateKey(
	event: WorkflowEventEnvelope,
): string {
	const data = event.data || {};
	return [
		"workflow-approval",
		String(data.executionId || "").trim() || "unknown-execution",
		String(data.nodeId || "").trim() || "unknown-node",
		String(data.eventName || "")
			.trim()
			.toLowerCase() || "approval",
	].join(":");
}

async function loadDeliveryState(
	baseUrl: string,
	storeName: string,
	key: string,
): Promise<NotificationDeliveryState | null> {
	const response = await fetch(
		`${baseUrl}/v1.0/state/${encodeURIComponent(storeName)}/${encodeURIComponent(key)}`,
		{ headers: { Accept: "application/json" } },
	);
	if (!response.ok) {
		return null;
	}
	const text = await response.text();
	if (!text.trim()) {
		return null;
	}
	try {
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		const deliveredReceivers = Array.isArray(parsed.deliveredReceivers)
			? parsed.deliveredReceivers
					.map((item: unknown) => String(item).trim())
					.filter(Boolean)
			: [];
		return {
			dedupeKey: String(parsed.dedupeKey || key),
			deliveredReceivers,
			lastAttemptAt: String(parsed.lastAttemptAt || ""),
		};
	} catch {
		return null;
	}
}

async function saveDeliveryState(
	baseUrl: string,
	storeName: string,
	state: NotificationDeliveryState,
): Promise<void> {
	await fetch(`${baseUrl}/v1.0/state/${encodeURIComponent(storeName)}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify([{ key: state.dedupeKey, value: state }]),
	});
}

export async function deliverApprovalRequestedNotification(
	event: WorkflowEventEnvelope,
	options: {
		receivers: NotificationReceiver[];
		workflowBuilderBaseUrl: string | null;
		stateStoreName: string;
		daprHttpBaseUrl: string;
	},
): Promise<DeliveryResult> {
	if (event.type !== "workflow.approval.requested") {
		return { delivered: [], skipped: [], failures: [] };
	}

	const enabledReceivers = options.receivers.filter(
		(receiver) => receiver.enabled !== false,
	);
	if (enabledReceivers.length === 0) {
		return { delivered: [], skipped: [], failures: [] };
	}

	const dedupeKey = approvalNotificationStateKey(event);
	const existingState = await loadDeliveryState(
		options.daprHttpBaseUrl,
		options.stateStoreName,
		dedupeKey,
	);
	const alreadyDelivered = new Set(existingState?.deliveredReceivers || []);
	const payload = buildApprovalNotificationPayload(
		event,
		options.workflowBuilderBaseUrl,
	);

	const delivered = new Set<string>(alreadyDelivered);
	const skipped: string[] = [];
	const failures: Array<{ receiver: string; error: string }> = [];

	for (const receiver of enabledReceivers) {
		if (delivered.has(receiver.name)) {
			skipped.push(receiver.name);
			continue;
		}
		try {
			const response = await fetch(receiver.url, {
				method: receiver.method || "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Workflow-Event-Type": "workflow.approval.requested",
					...(receiver.headers || {}),
				},
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout((receiver.timeoutSeconds || 5) * 1000),
			});
			if (!response.ok) {
				failures.push({
					receiver: receiver.name,
					error: `HTTP ${response.status}`,
				});
				continue;
			}
			delivered.add(receiver.name);
		} catch (error) {
			failures.push({
				receiver: receiver.name,
				error: error instanceof Error ? error.message : "request failed",
			});
		}
	}

	await saveDeliveryState(options.daprHttpBaseUrl, options.stateStoreName, {
		dedupeKey,
		deliveredReceivers: [...delivered],
		lastAttemptAt: new Date().toISOString(),
	});

	return {
		delivered: [...delivered].filter((name) => !alreadyDelivered.has(name)),
		skipped,
		failures,
	};
}

export async function parseJsonBody(
	request: AsyncIterable<Buffer | string>,
): Promise<unknown> {
	const chunks: string[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
	}
	const raw = chunks.join("").trim();
	if (!raw) {
		return null;
	}
	return JSON.parse(raw);
}
