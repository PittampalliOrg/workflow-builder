import type {
	WorkflowExecutionRuntimeHostCleanupCandidate,
	WorkflowExecutionRuntimeHostCleanupProvider,
	WorkflowExecutionRuntimeHostProviderCleanupResult,
} from "$lib/server/application/ports";
import {
	deleteCliStorageForSession,
	listCliStorageForSession,
} from "$lib/server/kube/client";
import { SandboxExecutionApiSessionSandboxDestroyer } from "./session-sandbox-destroyer";

type RuntimeSandboxDestroyer = Pick<
	SandboxExecutionApiSessionSandboxDestroyer,
	"deleteRuntimeSandbox"
>;

export class KubernetesWorkflowExecutionRuntimeHostCleanupProvider
	implements WorkflowExecutionRuntimeHostCleanupProvider
{
	constructor(
		private readonly deps: {
			sandboxes?: RuntimeSandboxDestroyer;
			deleteStorage?: typeof deleteCliStorageForSession;
			listStorage?: typeof listCliStorageForSession;
		} = {},
	) {}

	async cleanup(
		target: WorkflowExecutionRuntimeHostCleanupCandidate,
	): Promise<WorkflowExecutionRuntimeHostProviderCleanupResult> {
		const expectedSandbox = `agent-host-${target.runtimeAppId}`;
		if (target.runtimeSandboxName !== expectedSandbox) {
			return {
				status: "error",
				error: `runtime target mismatch: ${target.runtimeAppId} does not own ${target.runtimeSandboxName}`,
			};
		}
		const sandboxes =
			this.deps.sandboxes ?? new SandboxExecutionApiSessionSandboxDestroyer();
		let deletedSandbox = false;
		for (let proofPass = 0; proofPass < 2; proofPass += 1) {
			const deletion = await sandboxes.deleteRuntimeSandbox(expectedSandbox);
			if (deletion.status === "error") {
				return {
					status: "error",
					error:
						deletion.error ||
						`failed to delete workflow runtime Sandbox ${expectedSandbox}`,
				};
			}
			deletedSandbox ||= deletion.status === "deleted";

			try {
				await (this.deps.deleteStorage ?? deleteCliStorageForSession)(
					target.helperSessionId,
				);
				const remaining = await (
					this.deps.listStorage ?? listCliStorageForSession
				)(target.helperSessionId);
				if (proofPass === 1 && remaining.length > 0) {
					return {
						status: "error",
						error: `helper PVC deletion is still converging: ${remaining.join(", ")}`,
					};
				}
			} catch (error) {
				return {
					status: "error",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}

		// The second exact SEA/PVC pass closes a create-between-observations race.
		// A still-later create cannot publish or activate after the database CAS and
		// remains provisional, so its provider TTL is the final crash backstop.
		return {
			status: "cleaned",
			sandbox: deletedSandbox ? "deleted" : "missing",
		};
	}
}
