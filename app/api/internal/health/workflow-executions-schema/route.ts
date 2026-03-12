import { NextResponse } from "next/server";
import {
	ensureWorkflowExecutionsSchema,
	isWorkflowExecutionsSchemaError,
	workflowExecutionsSchemaErrorResponse,
} from "@/lib/db/workflow-executions-schema-guard";

export async function GET() {
	try {
		await ensureWorkflowExecutionsSchema();
		return NextResponse.json({
			ok: true,
			table: "workflow_executions",
		});
	} catch (error) {
		if (isWorkflowExecutionsSchemaError(error)) {
			return workflowExecutionsSchemaErrorResponse(error);
		}
		throw error;
	}
}
