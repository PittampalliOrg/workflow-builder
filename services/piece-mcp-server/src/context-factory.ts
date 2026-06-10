/**
 * Context Factory
 *
 * Builds a minimal ActionContext for AP piece action execution.
 * Most AP actions only use `auth` and `propsValue` — the rest are
 * stubbed out with no-ops, except:
 *
 *  - `run.pause` captures pause requests (DELAY/WEBHOOK) into pauseRef for
 *    the deterministic /execute path (the SW 1.0 orchestrator maps them
 *    onto Dapr timers / external events).
 *  - `executionType` is BEGIN or RESUME (the orchestrator re-invokes
 *    /execute with `execution_type: "RESUME"` after a pause resolves);
 *    on RESUME the webhook payload is exposed as `ctx.resumePayload`
 *    ({ body, headers, queryParams } — upstream AP's TriggerPayload shape).
 *  - `store` is a Postgres-backed adapter when /execute runs with a DB
 *    (see store-adapter.ts); the MCP path keeps the no-op store.
 *  - `generateResumeUrl` mirrors AP's engine: a per-invocation
 *    pauseRequestId in the URL path, also stamped into WEBHOOK pause
 *    metadata so the orchestrator can wait on `ap.resume.<requestId>`.
 *    Gated on AP_RESUME_PUBLIC_BASE_URL (unset ⇒ "" — WEBHOOK pauses
 *    unsupported on this cluster).
 */
import { randomUUID } from "node:crypto";
import type { ActionContext, Store, StoreScope } from "@activepieces/pieces-framework";

type ContextOptions = {
	auth: unknown;
	propsValue: Record<string, unknown>;
	executionId: string;
	actionName: string;
	/** BEGIN (default) or RESUME (pause re-invocation). */
	executionType?: "BEGIN" | "RESUME";
	/** Raw webhook payload for RESUME — normalized onto ctx.resumePayload. */
	resumePayload?: unknown;
	/** Durable ctx.store adapter (deterministic path only). */
	store?: Store;
	/** workflow_executions.id — required to mint resume URLs. */
	dbExecutionId?: string;
};

export type PauseCaptured = {
	type: "DELAY" | "WEBHOOK";
	resumeDateTime?: string;
	/** Pre-computed delay in seconds (for DELAY type). Avoids datetime.now() in Dapr workflow. */
	delaySeconds?: number;
	requestId?: string;
	response?: unknown;
};

export type ResumePayloadShape = {
	body: unknown;
	headers: Record<string, string>;
	queryParams: Record<string, string>;
};

const noop = () => {};

let warnedResumeUrlUnsupported = false;

/**
 * Normalize the orchestrator-forwarded `resume_payload` to upstream AP's
 * ResumePayload (TriggerPayload) shape. Payloads already carrying
 * body/headers/queryParams pass through; anything else becomes the body.
 */
export function normalizeResumePayload(raw: unknown): ResumePayloadShape {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const obj = raw as Record<string, unknown>;
		if ("body" in obj || "headers" in obj || "queryParams" in obj) {
			return {
				body: obj.body,
				headers:
					obj.headers && typeof obj.headers === "object"
						? (obj.headers as Record<string, string>)
						: {},
				queryParams:
					obj.queryParams && typeof obj.queryParams === "object"
						? (obj.queryParams as Record<string, string>)
						: {},
			};
		}
	}
	return { body: raw, headers: {}, queryParams: {} };
}

export function buildActionContext(options: ContextOptions): {
	context: ActionContext;
	pauseRef: { value: PauseCaptured | null };
} {
	const { auth, propsValue, executionId, actionName } = options;
	const executionType = options.executionType ?? "BEGIN";

	const pauseRef: { value: PauseCaptured | null } = { value: null };

	// Mirrors upstream AP's engine-generated executionState.pauseRequestId:
	// one id per step invocation, used both in the resume URL path and
	// stamped into WEBHOOK pause metadata (engine value wins over the
	// action's), so URL and `ap.resume.<requestId>` event stay correlated.
	const pauseRequestId = randomUUID();

	const generateResumeUrl = (params?: {
		queryParams?: Record<string, string>;
		sync?: boolean;
	}): string => {
		const base = process.env.AP_RESUME_PUBLIC_BASE_URL?.trim();
		if (!base || !options.dbExecutionId) {
			if (!warnedResumeUrlUnsupported) {
				warnedResumeUrlUnsupported = true;
				console.warn(
					"[piece-runtime] generateResumeUrl: " +
						(base
							? "no db_execution_id on this invocation"
							: "AP_RESUME_PUBLIC_BASE_URL is not set") +
						" — WEBHOOK pauses are unsupported on this cluster (returning \"\").",
				);
			}
			return "";
		}
		const url = new URL(
			`${base.replace(/\/+$/, "")}/api/internal/executions/${encodeURIComponent(
				options.dbExecutionId,
			)}/ap-resume/${encodeURIComponent(pauseRequestId)}`,
		);
		if (params?.queryParams) {
			url.search = new URLSearchParams(params.queryParams).toString();
		}
		return url.toString();
	};

	const context = {
		auth,
		propsValue,
		executionType,
		// Exposed unconditionally on RESUME — mirrors upstream AP's
		// ResumeExecutionActionContext (ctx.resumePayload for actions resumed
		// from a webhook).
		...(executionType === "RESUME"
			? { resumePayload: normalizeResumePayload(options.resumePayload) }
			: {}),

		store:
			options.store ??
			({
				put: async (_key: string, _value: unknown, _scope?: StoreScope) => {},
				get: async (_key: string, _scope?: StoreScope) => null,
				delete: async (_key: string, _scope?: StoreScope) => {},
			} as unknown as Store),

		files: {
			write: async (_params: { fileName: string; data: Buffer }) =>
				"https://stub-file-url",
		},

		server: {
			apiUrl: "",
			publicUrl: "",
			token: "",
		},

		run: {
			id: executionId,
			stop: noop as unknown as ActionContext["run"]["stop"],
			pause: ((req: {
				pauseMetadata: {
					type: string;
					resumeDateTime?: string;
					requestId?: string;
					response?: unknown;
				};
			}) => {
				const captured: PauseCaptured = {
					type: req.pauseMetadata.type as "DELAY" | "WEBHOOK",
					resumeDateTime: req.pauseMetadata.resumeDateTime,
					requestId: req.pauseMetadata.requestId,
					response: req.pauseMetadata.response,
				};

				// Pre-compute delaySeconds for DELAY pauses so the Dapr workflow
				// doesn't need to call datetime.now() (which breaks replay).
				if (captured.type === "DELAY" && captured.resumeDateTime) {
					try {
						const resumeMs = new Date(captured.resumeDateTime).getTime();
						const nowMs = Date.now();
						captured.delaySeconds = Math.max(
							0,
							Math.round((resumeMs - nowMs) / 1000),
						);
					} catch {
						captured.delaySeconds = 0;
					}
				}

				// Upstream AP injects the engine-generated pauseRequestId into
				// WEBHOOK pause metadata (overriding the action's) — keep parity
				// so the orchestrator waits on the same id the resume URL carries.
				if (captured.type === "WEBHOOK") {
					captured.requestId = pauseRequestId;
				}

				pauseRef.value = captured;
			}) as unknown as ActionContext["run"]["pause"],
			respond: noop as unknown as ActionContext["run"]["respond"],
		},

		step: {
			name: actionName,
		},

		project: {
			id: "default",
			externalId: async () => undefined,
		},

		connections: {
			get: async () => null,
		},

		tags: {
			add: async () => {},
		},

		output: {
			update: async () => {},
		},

		flows: {
			list: async () => ({ data: [], next: null, previous: null }),
			current: {
				id: "stub",
				version: { id: "stub" },
			},
		},

		agent: {
			tools: async () => ({}),
		},

		generateResumeUrl,
	} as unknown as ActionContext;

	return { context, pauseRef };
}
