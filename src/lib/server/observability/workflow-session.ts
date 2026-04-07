import { context, propagation, trace, type Context } from '@opentelemetry/api';

export const PHOENIX_SESSION_ATTRIBUTE = 'session.id';
export const WORKFLOW_EXECUTION_ATTRIBUTE = 'workflow.execution.id';

export function buildWorkflowSessionId(executionId: string | null | undefined): string | null {
	const normalized = typeof executionId === 'string' ? executionId.trim() : '';
	return normalized.length > 0 ? normalized : null;
}

export function bindWorkflowSessionContext(sessionId: string): Context {
	const activeContext = context.active();
	const currentSpan = trace.getSpan(activeContext);
	currentSpan?.setAttribute(PHOENIX_SESSION_ATTRIBUTE, sessionId);
	currentSpan?.setAttribute(WORKFLOW_EXECUTION_ATTRIBUTE, sessionId);

	const existingBaggage = propagation.getBaggage(activeContext);
	const nextEntries = {
		...(existingBaggage ? Object.fromEntries(existingBaggage.getAllEntries()) : {}),
		[PHOENIX_SESSION_ATTRIBUTE]: { value: sessionId },
		[WORKFLOW_EXECUTION_ATTRIBUTE]: { value: sessionId }
	};
	const baggage = propagation.createBaggage(nextEntries);
	return propagation.setBaggage(activeContext, baggage);
}

export function injectWorkflowSessionHeaders(
	headers: Record<string, string>,
	sessionId: string
): Record<string, string> {
	const sessionContext = bindWorkflowSessionContext(sessionId);
	const nextHeaders = { ...headers };
	propagation.inject(sessionContext, nextHeaders);
	nextHeaders['x-workflow-session-id'] = sessionId;
	return nextHeaders;
}
