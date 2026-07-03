import type { WorkflowTriggerLifecyclePort, WorkflowTriggerStore } from "$lib/server/application/ports";
import { WorkflowTriggerLifecycleReconciler } from "$lib/server/lifecycle/trigger-reconciler";

export class WorkflowTriggerLifecycleAdapter implements WorkflowTriggerLifecyclePort {
	private readonly reconciler: WorkflowTriggerLifecycleReconciler;

	constructor(triggers: Pick<WorkflowTriggerStore, "getById" | "updateLifecycleState">) {
		this.reconciler = new WorkflowTriggerLifecycleReconciler({ triggers });
	}

	activateTrigger(triggerId: string) {
		return this.reconciler.activateTrigger(triggerId);
	}

	deactivateTrigger(triggerId: string) {
		return this.reconciler.deactivateTrigger(triggerId);
	}
}
