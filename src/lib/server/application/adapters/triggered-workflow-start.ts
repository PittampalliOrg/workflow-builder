import type {
	TriggeredRunAdmissionPort,
	TriggeredWorkflowExecutionIdPort,
} from "$lib/server/application/triggered-workflow-start";
import { triggerExecutionId } from "$lib/server/workflows/trigger-id";
import { admitTriggeredRun } from "$lib/server/workflows/trigger-gate";

export class LegacyTriggeredRunAdmissionPort
	implements TriggeredRunAdmissionPort
{
	admitTriggeredRun() {
		return admitTriggeredRun();
	}
}

export class ShaTriggeredWorkflowExecutionIdPort
	implements TriggeredWorkflowExecutionIdPort
{
	executionIdForDedupKey(dedupKey: string) {
		return triggerExecutionId(dedupKey);
	}
}
