/**
 * Context Factory
 *
 * Builds a minimal ActionContext for AP piece action execution.
 * Most AP actions only use `auth` and `propsValue` — the rest are
 * stubbed out with no-ops.
 *
 * Copied from fn-activepieces/src/context-factory.ts.
 */
import type { ActionContext, StoreScope } from "@activepieces/pieces-framework";

type ContextOptions = {
	auth: unknown;
	propsValue: Record<string, unknown>;
	executionId: string;
	actionName: string;
};

const noop = () => {};

export function buildActionContext(options: ContextOptions): {
	context: ActionContext;
} {
	const { auth, propsValue, executionId, actionName } = options;

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
			pause: noop as unknown as ActionContext["run"]["pause"],
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

		generateResumeUrl: () => "",
	} as unknown as ActionContext;

	return { context };
}
