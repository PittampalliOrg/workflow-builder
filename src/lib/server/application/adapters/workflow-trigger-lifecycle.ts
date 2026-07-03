import type { WorkflowTriggerLifecyclePort } from "$lib/server/application/ports";
import {
	activateWorkflowTrigger,
	deactivateWorkflowTrigger,
} from "$lib/server/lifecycle/trigger-reconciler";

export class LegacyWorkflowTriggerLifecyclePort
	implements WorkflowTriggerLifecyclePort
{
	activateTrigger(triggerId: string) {
		return activateWorkflowTrigger(triggerId);
	}

	deactivateTrigger(triggerId: string) {
		return deactivateWorkflowTrigger(triggerId);
	}
}
