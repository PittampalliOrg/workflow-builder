import type { SandboxProvisioner } from "$lib/server/application/ports";
import {
	provisionSessionSandboxWithRetry,
	type SandboxProvisionInput,
	type SandboxProvisionResult,
} from "$lib/server/sandboxes/provision";

export class WorkspaceRuntimeSandboxProvisioner implements SandboxProvisioner {
	provision(input: SandboxProvisionInput): Promise<SandboxProvisionResult> {
		return provisionSessionSandboxWithRetry(input);
	}
}
