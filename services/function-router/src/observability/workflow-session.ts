import { context, propagation, trace, type Context } from "@opentelemetry/api";

const SESSION_ID_ATTRIBUTE = "session.id";
const WORKFLOW_EXECUTION_ATTRIBUTE = "workflow.execution.id";

export function buildWorkflowSessionId(
	executionId: string | null | undefined,
): string | null {
	const normalized = typeof executionId === "string" ? executionId.trim() : "";
	return normalized.length > 0 ? normalized : null;
}

export function bindWorkflowSessionContext(sessionId: string): Context {
	const activeContext = context.active();
	const currentSpan = trace.getSpan(activeContext);
	currentSpan?.setAttribute(SESSION_ID_ATTRIBUTE, sessionId);
	currentSpan?.setAttribute(WORKFLOW_EXECUTION_ATTRIBUTE, sessionId);

	const existingBaggage = propagation.getBaggage(activeContext);
	const nextEntries = {
		...(existingBaggage
			? Object.fromEntries(existingBaggage.getAllEntries())
			: {}),
		[SESSION_ID_ATTRIBUTE]: { value: sessionId },
		[WORKFLOW_EXECUTION_ATTRIBUTE]: { value: sessionId },
	};
	const baggage = propagation.createBaggage(nextEntries);
	return propagation.setBaggage(activeContext, baggage);
}

export function sessionIdFromHeaders(
	headers: Record<string, unknown>,
): string | null {
	const explicit = headers["x-workflow-session-id"];
	if (typeof explicit === "string" && explicit.trim().length > 0) {
		return explicit.trim();
	}
	const baggageHeader = headers.baggage;
	if (typeof baggageHeader !== "string") return null;
	for (const part of baggageHeader.split(",")) {
		const [rawKey, rawValue] = part.split("=", 2);
		if (!rawKey || !rawValue) continue;
		if (rawKey.trim().toLowerCase() === SESSION_ID_ATTRIBUTE) {
			const decoded = decodeURIComponent(rawValue.trim());
			return decoded.length > 0 ? decoded : null;
		}
	}
	return null;
}
