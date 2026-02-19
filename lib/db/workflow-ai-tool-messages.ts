/**
 * Returns true when the DB error indicates the workflow_ai_tool_messages table
 * is not available yet (e.g. migration not applied).
 */
export function isWorkflowAiToolMessagesTableMissing(error: unknown): boolean {
	const visited = new Set<unknown>();

	function check(err: unknown): boolean {
		if (!(err instanceof Error)) {
			return false;
		}

		if (visited.has(err)) {
			return false;
		}
		visited.add(err);

		const maybeCode = (err as { code?: string }).code;
		if (maybeCode === "42P01") {
			return true;
		}

		const message = err.message.toLowerCase();
		if (
			message.includes("workflow_ai_tool_messages") &&
			(message.includes("does not exist") || message.includes("relation"))
		) {
			return true;
		}

		if (
			message.includes("failed query") &&
			message.includes("workflow_ai_tool_messages")
		) {
			return true;
		}

		const cause = (err as { cause?: unknown }).cause;
		if (cause && check(cause)) {
			return true;
		}

		return false;
	}

	return check(error);
}
