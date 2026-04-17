import { sql } from '$lib/server/db';

const EXECUTION_READ_MODEL_COLUMNS = [
	'current_node_id',
	'current_node_name',
	'primary_trace_id',
	'workflow_session_id',
	'summary_output'
] as const;

const EXECUTION_READ_MODEL_MIGRATIONS = [
	'atlas/migrations/20260408120000_add_execution_read_model_columns.sql',
	'drizzle/0024_execution_read_model.sql'
] as const;

let cachedAssertion: Promise<void> | null = null;

export function getExecutionReadModelSchemaError(missingColumns: string[]) {
	const missing = missingColumns.join(', ');
	const migrations = EXECUTION_READ_MODEL_MIGRATIONS.join(' or ');
	return new Error(
		`Execution read-model schema is missing required workflow_executions columns: ${missing}. Apply ${migrations} before starting workflow-builder.`
	);
}

export async function assertExecutionReadModelColumns(): Promise<void> {
	if (!sql) {
		throw new Error('Database client is not configured');
	}

	if (!cachedAssertion) {
		cachedAssertion = (async () => {
			const rows = await sql<{ column_name: string }[]>`
				select column_name
				from information_schema.columns
				where table_schema = 'public'
					and table_name = 'workflow_executions'
			`;

			const existing = new Set(rows.map((row) => row.column_name));
			const missingColumns = EXECUTION_READ_MODEL_COLUMNS.filter((column) => !existing.has(column));
			if (missingColumns.length > 0) {
				throw getExecutionReadModelSchemaError(missingColumns);
			}
		})().catch((error) => {
			cachedAssertion = null;
			throw error;
		});
	}

	return cachedAssertion;
}
