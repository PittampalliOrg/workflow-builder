/**
 * Context Factory
 *
 * Builds a minimal ActionContext for AP piece action execution.
 * Most AP actions only use `auth` and `propsValue` — the rest are
 * stubbed out with no-ops.
 */
import type { ActionContext, StoreScope } from '@activepieces/pieces-framework';

interface ContextOptions {
  auth: unknown;
  propsValue: Record<string, unknown>;
  executionId: string;
  actionName: string;
}

export interface PauseCaptured {
  type: 'DELAY' | 'WEBHOOK';
  resumeDateTime?: string;
  requestId?: string;
  response?: unknown;
}

const noop = () => {};
const asyncNoop = async () => {};

/**
 * Build a minimal ActionContext that satisfies the AP framework interface.
 * Returns both the context and a pauseRef that captures any pause requests.
 */
export function buildActionContext(options: ContextOptions): { context: ActionContext; pauseRef: { value: PauseCaptured | null } } {
  const { auth, propsValue, executionId, actionName } = options;

  const pauseRef: { value: PauseCaptured | null } = { value: null };

  const context = {
    auth,
    propsValue,
    executionType: 'BEGIN' as const,

    // Store — no-op stubs (our 25 pieces don't use persistent store)
    store: {
      put: async (_key: string, _value: unknown, _scope?: StoreScope) => {},
      get: async (_key: string, _scope?: StoreScope) => null,
      delete: async (_key: string, _scope?: StoreScope) => {},
    },

    // Files — no-op stub
    files: {
      write: async (_params: { fileName: string; data: Buffer }) =>
        'https://stub-file-url',
    },

    // Server info — stubs
    server: {
      apiUrl: '',
      publicUrl: '',
      token: '',
    },

    // Run control — pause captures metadata for Dapr handling
    run: {
      id: executionId,
      stop: noop as unknown as ActionContext['run']['stop'],
      pause: ((req: { pauseMetadata: { type: string; resumeDateTime?: string; requestId?: string; response?: unknown } }) => {
        pauseRef.value = {
          type: req.pauseMetadata.type as 'DELAY' | 'WEBHOOK',
          resumeDateTime: req.pauseMetadata.resumeDateTime,
          requestId: req.pauseMetadata.requestId,
          response: req.pauseMetadata.response,
        };
      }) as unknown as ActionContext['run']['pause'],
      respond: noop as unknown as ActionContext['run']['respond'],
    },

    // Step info
    step: {
      name: actionName,
    },

    // Project — stubs
    project: {
      id: 'default',
      externalId: async () => undefined,
    },

    // Connections — stub (credentials come via auth directly)
    connections: {
      get: async () => null,
    },

    // Tags — no-op
    tags: {
      add: async () => {},
    },

    // Output — no-op
    output: {
      update: async () => {},
    },

    // Flows — stubs
    flows: {
      list: async () => ({ data: [], next: null, previous: null }),
      current: {
        id: 'stub',
        version: { id: 'stub' },
      },
    },

    // Agent tools — stub
    agent: {
      tools: async () => ({}),
    },

    // Resume URL — stub
    generateResumeUrl: () => '',
  } as unknown as ActionContext;

  return { context, pauseRef };
}
