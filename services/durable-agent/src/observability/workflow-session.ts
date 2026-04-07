import { context, propagation, trace, type Context } from "@opentelemetry/api";

export const PHOENIX_SESSION_ATTRIBUTE = "session.id";
export const WORKFLOW_EXECUTION_ATTRIBUTE = "workflow.execution.id";

export function buildWorkflowSessionId(
	executionId: string | null | undefined,
): string | null {
	const normalized = typeof executionId === "string" ? executionId.trim() : "";
	return normalized.length > 0 ? normalized : null;
}

export function bindWorkflowSessionContext(sessionId: string): Context {
	const activeContext = context.active();
	const currentSpan = trace.getSpan(activeContext);
	currentSpan?.setAttribute(PHOENIX_SESSION_ATTRIBUTE, sessionId);
	currentSpan?.setAttribute(WORKFLOW_EXECUTION_ATTRIBUTE, sessionId);

	const existingBaggage = propagation.getBaggage(activeContext);
	const nextEntries = {
		...(existingBaggage
			? Object.fromEntries(existingBaggage.getAllEntries())
			: {}),
		[PHOENIX_SESSION_ATTRIBUTE]: { value: sessionId },
		[WORKFLOW_EXECUTION_ATTRIBUTE]: { value: sessionId },
	};
	const baggage = propagation.createBaggage(nextEntries);
	return propagation.setBaggage(activeContext, baggage);
}

export function resolveWorkflowSessionId(input: {
	executionId?: string;
	traceContext?: Record<string, unknown>;
}): string | null {
	const direct = buildWorkflowSessionId(input.executionId);
	if (direct) return direct;

	const traceContext = input.traceContext;
	const explicit =
		typeof traceContext?.sessionId === "string"
			? traceContext.sessionId.trim()
			: typeof traceContext?.session_id === "string"
				? traceContext.session_id.trim()
				: typeof traceContext?.["session.id"] === "string"
					? String(traceContext["session.id"]).trim()
					: "";
	return explicit.length > 0 ? explicit : null;
}
