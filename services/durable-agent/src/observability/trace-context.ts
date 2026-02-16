/**
 * Trace context propagation utilities.
 * Mirrors Python dapr_agents/observability/context_propagation.py.
 */

/**
 * Extract trace context from workflow input for propagation.
 */
export function extractTraceContext(
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return input._otel_span_context as Record<string, unknown> | undefined;
}

/**
 * Inject trace context into a message payload.
 */
export function injectTraceContext(
  payload: Record<string, unknown>,
  traceContext: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!traceContext) return payload;
  return {
    ...payload,
    _otel_span_context: traceContext,
  };
}
