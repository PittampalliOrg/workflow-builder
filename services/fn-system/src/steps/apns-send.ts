import { z } from "zod";

const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const DAPR_HTTP_BASE_URL =
	process.env.DAPR_HTTP_BASE_URL || `http://127.0.0.1:${DAPR_HTTP_PORT}`;
const DEFAULT_TIMEOUT_MS = Number.parseInt(
	process.env.APNS_BINDING_TIMEOUT_MS || "30000",
	10,
);

const PUSH_TYPES = [
	"alert",
	"background",
	"voip",
	"complication",
	"fileprovider",
	"mdm",
	"location",
	"liveactivity",
	"pushtotalk",
] as const;

export const ApnsSendInputSchema = z
	.object({
		environment: z.enum(["dev", "prod"]).default("dev"),
		deviceToken: z.string().trim().min(1),
		topic: z.string().trim().min(1),
		title: z.string().optional(),
		body: z.string().optional(),
		sound: z.string().optional(),
		badge: z.number().int().nonnegative().optional(),
		pushType: z.enum(PUSH_TYPES).default("alert"),
		priority: z.enum(["5", "10"]).default("10"),
		collapseId: z.string().trim().optional(),
		expiration: z.number().int().nonnegative().optional(),
		payload: z.record(z.string(), z.unknown()).optional(),
		metadata: z.record(z.string(), z.string()).optional(),
		timeoutMs: z.number().int().positive().optional(),
	})
	.refine(
		(value) =>
			value.payload !== undefined ||
			value.title !== undefined ||
			value.body !== undefined ||
			value.badge !== undefined ||
			value.sound !== undefined,
		"Provide `payload` or at least one of `title`, `body`, `badge`, `sound`",
	);

export type ApnsSendInput = z.infer<typeof ApnsSendInputSchema>;

type StepResult =
	| { success: true; data: unknown }
	| { success: false; error: string };

function resolveComponentName(environment: ApnsSendInput["environment"]) {
	return environment === "prod" ? "workflow-apns-prod" : "workflow-apns-dev";
}

function buildAlertData(input: ApnsSendInput): Record<string, unknown> {
	if (input.payload) return input.payload;

	const alert: Record<string, unknown> = {};
	if (input.title !== undefined) alert.title = input.title;
	if (input.body !== undefined) alert.body = input.body;

	const aps: Record<string, unknown> = {};
	if (Object.keys(alert).length > 0) aps.alert = alert;
	if (input.badge !== undefined) aps.badge = input.badge;
	if (input.sound !== undefined) aps.sound = input.sound;

	return { aps };
}

function buildMetadata(input: ApnsSendInput): Record<string, string> {
	const metadata: Record<string, string> = {
		"device-token": input.deviceToken,
		"apns-topic": input.topic,
		"apns-push-type": input.pushType,
		"apns-priority": input.priority,
	};
	if (input.collapseId !== undefined) {
		metadata["apns-collapse-id"] = input.collapseId;
	}
	if (input.expiration !== undefined) {
		metadata["apns-expiration"] = String(input.expiration);
	}
	return { ...metadata, ...(input.metadata ?? {}) };
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function extractApnsReason(parsed: unknown, fallback: string): string {
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		const record = parsed as Record<string, unknown>;
		if (typeof record.reason === "string") return record.reason;
		if (typeof record.error_description === "string") return record.error_description;
		if (typeof record.message === "string") return record.message;
	}
	return fallback;
}

export async function apnsSendStep(input: ApnsSendInput): Promise<StepResult> {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	const componentName = resolveComponentName(input.environment);
	const url = `${DAPR_HTTP_BASE_URL}/v1.0/bindings/${encodeURIComponent(componentName)}`;

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				operation: "create",
				data: buildAlertData(input),
				metadata: buildMetadata(input),
			}),
			signal: controller.signal,
		});
		const text = await response.text();
		const parsed = text ? parseJson(text) : {};

		if (!response.ok) {
			const reason = extractApnsReason(parsed, text || response.statusText);
			return {
				success: false,
				error: `APNs binding ${componentName} failed with HTTP ${response.status}: ${reason}`,
			};
		}

		return { success: true, data: parsed ?? {} };
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			return {
				success: false,
				error: `APNs binding request timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
			};
		}
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timeout);
	}
}

const apnsInputSchema = {
	type: "object",
	required: ["deviceToken", "topic"],
	properties: {
		environment: {
			type: "string",
			enum: ["dev", "prod"],
			default: "dev",
			description:
				"Which APNs environment to target. `dev` routes to the APNs sandbox via the `workflow-apns-dev` component; `prod` routes to production via `workflow-apns-prod`.",
		},
		deviceToken: {
			type: "string",
			description:
				"The device token registered by the target iOS/macOS app. Required.",
		},
		topic: {
			type: "string",
			description:
				"The apns-topic header. MUST match the bundle ID registered with the APNs key (e.g. com.pittampalli.workflow-builder) or APNs returns 403.",
		},
		title: {
			type: "string",
			description: "Alert title. Ignored when `payload` is provided.",
		},
		body: {
			type: "string",
			description: "Alert body text. Ignored when `payload` is provided.",
		},
		badge: {
			type: "integer",
			minimum: 0,
			description: "App icon badge number. Ignored when `payload` is provided.",
		},
		sound: {
			type: "string",
			description: "Sound file name. Ignored when `payload` is provided.",
		},
		pushType: {
			type: "string",
			enum: [...PUSH_TYPES],
			default: "alert",
			description: "Maps to the `apns-push-type` header.",
		},
		priority: {
			type: "string",
			enum: ["5", "10"],
			default: "10",
			description:
				"Maps to the `apns-priority` header. 10 = send immediately; 5 = power-considerate.",
		},
		collapseId: {
			type: "string",
			description:
				"Optional `apns-collapse-id`. APNs coalesces notifications sharing a collapse ID into one display.",
		},
		expiration: {
			type: "integer",
			minimum: 0,
			description:
				"Optional `apns-expiration` (Unix epoch seconds). 0 = deliver immediately or not at all.",
		},
		payload: {
			type: "object",
			description:
				"Raw APNs payload. When set, takes precedence over the structured alert fields. See https://developer.apple.com/documentation/usernotifications/setting_up_a_remote_notification_server/generating_a_remote_notification",
		},
		metadata: {
			type: "object",
			additionalProperties: { type: "string" },
			description:
				"Advanced: extra APNs headers merged on top of the ones this step sets. Useful for `apns-id`, `apns-unique-id`, or future headers not yet first-class.",
		},
		timeoutMs: {
			type: "integer",
			minimum: 1,
			description: "HTTP timeout (ms) when calling the Dapr sidecar binding endpoint.",
		},
	},
};

export const APNS_SEND_ACTIONS = [
	{
		id: "system-apns-send",
		name: "system-apns-send",
		slug: "system/apns-send",
		displayName: "Send Apple Push Notification",
		description:
			"Emit an Apple Push Notification via the Dapr APNs output binding. Uses the `workflow-apns-dev` or `workflow-apns-prod` component depending on the selected environment.",
		providerId: "system",
		providerLabel: "System",
		providerIconUrl: null,
		category: "Notifications",
		service: "fn-system",
		runtime: "node-dapr-conversation",
		kind: "sw-function",
		visibility: "public-callable",
		sourceKind: "integration",
		auth: null,
		fields: null,
		tags: ["dapr", "bindings", "apns", "notifications", "push"],
		pieceName: "system",
		actionName: "apns-send",
		version: "1.0.0",
		insertable: true,
		signature: {
			parameters: [],
			inputSchema: apnsInputSchema,
		},
		taskConfig: {
			call: "system/apns-send",
			with: {
				body: {
					input: {
						environment: "dev",
						deviceToken: "",
						topic: "",
						title: "",
						body: "",
						pushType: "alert",
						priority: "10",
					},
				},
			},
		},
		definition: {
			call: "http",
			with: {
				method: "post",
				endpoint: {
					uri: "http://fn-system.workflow-builder.svc.cluster.local/execute",
				},
				body: {
					step: "apns-send",
					input: {
						environment: "dev",
						deviceToken: "",
						topic: "",
						title: "",
						body: "",
						pushType: "alert",
						priority: "10",
					},
				},
			},
			input: {
				schema: { format: "json", document: apnsInputSchema },
			},
		},
		swCompatibility: {
			status: "compatible",
			reasons: [],
			projection: {
				functionRefName: "system/apns-send",
				call: "system/apns-send",
				inputShape: "object",
			},
		},
	},
] as const;
