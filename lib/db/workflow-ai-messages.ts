/**
 * Returns true when the DB error indicates the workflow_ai_messages table is
 * not available yet (e.g. migration not applied).
 */
export function isWorkflowAiMessagesTableMissing(error: unknown): boolean {
	const visited = new Set<unknown>();

	function check(err: unknown): boolean {
		if (!(err instanceof Error)) {
			return false;
		}

		if (visited.has(err)) {
			return false;
		}
		visited.add(err);

		// Postgres "undefined_table"
		const maybeCode = (err as { code?: string }).code;
		if (maybeCode === "42P01") {
			return true;
		}

		// drizzle-orm can wrap a Postgres error as DrizzleQueryError and include only
		// the SQL in the message. Prefer following `.cause` when present.
		const message = err.message.toLowerCase();
		if (
			message.includes("workflow_ai_messages") &&
			(message.includes("does not exist") || message.includes("relation"))
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
