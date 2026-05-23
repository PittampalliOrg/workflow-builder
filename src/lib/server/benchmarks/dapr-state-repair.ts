export const SWEBENCH_PARENT_INSTANCE_PREFIX = "sw-swebench-instance-exec-";

export type SwebenchDaprRepairDecisionInput = {
	instanceId: string;
	ageHours: number | null;
	activeRunCount: number;
	activeLeaseCount: number;
	minAgeHours?: number;
};

export type SwebenchDaprRepairDecision = {
	repair: boolean;
	reason: string;
	effectiveMinAgeHours: number;
	benchmarkOwned: boolean;
};

export function isSwebenchParentWorkflowInstanceId(instanceId: string): boolean {
	return instanceId.trim().startsWith(SWEBENCH_PARENT_INSTANCE_PREFIX);
}

export function swebenchDaprRepairDecision(
	input: SwebenchDaprRepairDecisionInput,
): SwebenchDaprRepairDecision {
	const benchmarkOwned = isSwebenchParentWorkflowInstanceId(input.instanceId);
	if (!benchmarkOwned) {
		return {
			repair: false,
			reason: "non_swebench_instance",
			effectiveMinAgeHours: input.minAgeHours ?? 6,
			benchmarkOwned,
		};
	}
	if (input.activeRunCount > 0 || input.activeLeaseCount > 0) {
		return {
			repair: false,
			reason: "active_benchmark_resources",
			effectiveMinAgeHours: 0,
			benchmarkOwned,
		};
	}
	const effectiveMinAgeHours = Math.min(input.minAgeHours ?? 6, 0);
	if (input.ageHours != null && input.ageHours < effectiveMinAgeHours) {
		return {
			repair: false,
			reason: "too_young",
			effectiveMinAgeHours,
			benchmarkOwned,
		};
	}
	return {
		repair: true,
		reason: "benchmark_scoped_repair",
		effectiveMinAgeHours,
		benchmarkOwned,
	};
}

function containsDaprInstanceKey(key: string, instanceId: string): boolean {
	return key.includes(`||${instanceId}||`);
}

export function selectSwebenchDaprStateKeysForRepair(params: {
	keys: string[];
	parentInstanceId: string;
	childInstanceIds?: string[];
}): string[] {
	const parent = params.parentInstanceId.trim();
	if (!isSwebenchParentWorkflowInstanceId(parent)) return [];
	const allowedIds = new Set(
		[
			parent,
			`${parent}__durable__`,
			...(params.childInstanceIds ?? []),
		].filter((value) => value.trim()),
	);
	return params.keys.filter((key) => {
		for (const id of allowedIds) {
			if (id.endsWith("__durable__")) {
				if (key.includes(`||${id}`)) return true;
			} else if (containsDaprInstanceKey(key, id)) {
				return true;
			}
		}
		return false;
	});
}
