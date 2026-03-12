import { NextResponse } from "next/server";
import { migrationClient } from "@/lib/db";

const REQUIRED_COLUMNS = [
	"error_stack_trace",
	"rerun_of_execution_id",
	"rerun_source_instance_id",
	"rerun_from_event_id",
] as const;

export const REQUIRED_WORKFLOW_EXECUTIONS_ATLAS_MIGRATION =
	"20260310143000_add_workflow_execution_rerun_fields";

export class WorkflowExecutionsSchemaError extends Error {
	readonly code = "schema_out_of_date";
	readonly table = "workflow_executions";
	readonly requiredAtlasMigration =
		REQUIRED_WORKFLOW_EXECUTIONS_ATLAS_MIGRATION;

	constructor(readonly missingColumns: string[]) {
		super("Database schema is missing required workflow execution columns");
		this.name = "WorkflowExecutionsSchemaError";
	}
}

let schemaCheckPromise: Promise<void> | null = null;

export function isWorkflowExecutionsSchemaError(
	error: unknown,
): error is WorkflowExecutionsSchemaError {
	return error instanceof WorkflowExecutionsSchemaError;
}

export async function ensureWorkflowExecutionsSchema(): Promise<void> {
	if (!schemaCheckPromise) {
		schemaCheckPromise = (async () => {
			const rows = await migrationClient<{ column_name: string }[]>`
				select column_name
				from information_schema.columns
				where table_schema = 'public'
					and table_name = 'workflow_executions'
			`;

			const availableColumns = new Set(rows.map((row) => row.column_name));
			const missingColumns = REQUIRED_COLUMNS.filter(
				(column) => !availableColumns.has(column),
			);

			if (missingColumns.length > 0) {
				throw new WorkflowExecutionsSchemaError([...missingColumns]);
			}
		})();
	}

	try {
		await schemaCheckPromise;
	} catch (error) {
		schemaCheckPromise = null;
		throw error;
	}
}

export function workflowExecutionsSchemaErrorResponse(
	error: WorkflowExecutionsSchemaError,
) {
	return NextResponse.json(
		{
			code: error.code,
			error: error.message,
			table: error.table,
			missingColumns: error.missingColumns,
			requiredAtlasMigration: error.requiredAtlasMigration,
		},
		{ status: 503 },
	);
}

export async function getWorkflowExecutionsSchemaGuardResponse() {
	try {
		await ensureWorkflowExecutionsSchema();
		return null;
	} catch (error) {
		if (isWorkflowExecutionsSchemaError(error)) {
			return workflowExecutionsSchemaErrorResponse(error);
		}
		throw error;
	}
}
