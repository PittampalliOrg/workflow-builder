import { createTwoFilesPatch } from "diff";
import type {
	WorkflowDataService,
	WorkflowExecutionRecord,
} from "$lib/server/application/ports";
import { getTask, getTaskNames, type Spec } from "$lib/helpers/spec-mutations";

type SpecLike = Spec | null;

export type WorkflowExecutionSpecDiffInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
};

export type WorkflowExecutionSpecDiffBody =
	| {
			hasParent: false;
			parentId: null;
			fromNode: string | null;
	  }
	| {
			hasParent: true;
			parentId: string;
			fromNode: string | null;
			snapshotUnavailable: true;
	  }
	| {
			hasParent: true;
			parentId: string;
			fromNode: string | null;
			snapshotUnavailable: false;
			added: string[];
			removed: string[];
			changed: Array<{ name: string; patch: string }>;
	  };

export type WorkflowExecutionSpecDiffResult =
	| { status: "ok"; body: WorkflowExecutionSpecDiffBody }
	| { status: "error"; httpStatus: number; message: string };

export class ApplicationWorkflowExecutionSpecDiffService {
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
				"getScopedExecutionById" | "getExecutionById"
			>;
		},
	) {}

	async getSpecDiff(
		input: WorkflowExecutionSpecDiffInput,
	): Promise<WorkflowExecutionSpecDiffResult> {
		const self = await this.deps.workflowData.getScopedExecutionById({
			executionId: input.executionId,
			userId: input.userId,
			projectId: input.projectId ?? null,
		});
		if (!self) {
			return {
				status: "error",
				httpStatus: 404,
				message: "Execution not found",
			};
		}

		return {
			status: "ok",
			body: await this.buildBody(self),
		};
	}

	private async buildBody(
		self: WorkflowExecutionRecord,
	): Promise<WorkflowExecutionSpecDiffBody> {
		const parentId = self.rerunOfExecutionId ?? null;
		if (!parentId) {
			return {
				hasParent: false,
				parentId: null,
				fromNode: self.resumeFromNode ?? null,
			};
		}

		const parent = await this.deps.workflowData.getExecutionById(parentId);
		const thisSpec = specOf(self.executionIr);
		const parentSpec = parent ? specOf(parent.executionIr) : null;
		if (!thisSpec || !parentSpec) {
			return {
				hasParent: true,
				parentId,
				fromNode: self.resumeFromNode ?? null,
				snapshotUnavailable: true,
			};
		}

		const parentNames = getTaskNames(parentSpec);
		const thisNames = getTaskNames(thisSpec);
		const parentSet = new Set(parentNames);
		const thisSet = new Set(thisNames);

		const added = thisNames.filter((name) => !parentSet.has(name));
		const removed = parentNames.filter((name) => !thisSet.has(name));
		const changed: Array<{ name: string; patch: string }> = [];

		for (const name of thisNames) {
			if (!parentSet.has(name)) continue;
			const before = taskJson(parentSpec, name);
			const after = taskJson(thisSpec, name);
			if (before === after) continue;
			changed.push({
				name,
				patch: createTwoFilesPatch(
					`${name} (parent)`,
					`${name} (this run)`,
					before,
					after,
					"",
					"",
				),
			});
		}

		return {
			hasParent: true,
			parentId,
			fromNode: self.resumeFromNode ?? null,
			snapshotUnavailable: false,
			added,
			removed,
			changed,
		};
	}
}

function specOf(executionIr: unknown): SpecLike {
	if (!executionIr || typeof executionIr !== "object") return null;
	const spec = (executionIr as Record<string, unknown>).spec;
	return spec && typeof spec === "object" ? (spec as Spec) : null;
}

function taskJson(spec: Spec, name: string): string {
	return `${JSON.stringify(getTask(spec, name) ?? {}, null, 2)}\n`;
}
