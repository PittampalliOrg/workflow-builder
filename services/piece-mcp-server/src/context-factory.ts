/**
 * Context Factory
 *
 * Builds a minimal ActionContext for AP piece action execution.
 * Most AP actions only use `auth` and `propsValue` — the rest are
 * stubbed out with no-ops, except `run.pause` which captures pause
 * requests (DELAY/WEBHOOK) into pauseRef for the deterministic
 * /execute path (the SW 1.0 orchestrator maps them onto Dapr timers
 * and external events).
 */
import type { ActionContext, StoreScope } from "@activepieces/pieces-framework";

type ContextOptions = {
	auth: unknown;
	propsValue: Record<string, unknown>;
	executionId: string;
	actionName: string;
};

export type PauseCaptured = {
	type: "DELAY" | "WEBHOOK";
	resumeDateTime?: string;
	/** Pre-computed delay in seconds (for DELAY type). Avoids datetime.now() in Dapr workflow. */
	delaySeconds?: number;
	requestId?: string;
	response?: unknown;
};

const noop = () => {};

export function buildActionContext(options: ContextOptions): {
	context: ActionContext;
	pauseRef: { value: PauseCaptured | null };
} {
	const { auth, propsValue, executionId, actionName } = options;

	const pauseRef: { value: PauseCaptured | null } = { value: null };

	const context = {
		auth,
		propsValue,
		executionType: "BEGIN" as const,

		store: {
			put: async (_key: string, _value: unknown, _scope?: StoreScope) => {},
			get: async (_key: string, _scope?: StoreScope) => null,
			delete: async (_key: string, _scope?: StoreScope) => {},
		},

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

		// Phase 2 wires this to the BFF ap-resume endpoint (gated on
		// AP_RESUME_PUBLIC_BASE_URL); empty string means WEBHOOK pauses
		// are unsupported on this cluster.
		generateResumeUrl: () => "",
	} as unknown as ActionContext;

	return { context, pauseRef };
}
