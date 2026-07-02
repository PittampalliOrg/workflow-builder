import type {
	SandboxProvisioner,
	SandboxRuntimeInventory,
	SandboxRuntimeRecord,
} from "$lib/server/application/ports";
import { openshellRuntimeFetch } from "$lib/server/openshell-runtime";
import {
	provisionSessionSandboxWithRetry,
	type SandboxProvisionInput,
	type SandboxProvisionResult,
} from "$lib/server/sandboxes/provision";
import { normalizeSandboxResponse } from "$lib/utils/sandbox-parse";

export class WorkspaceRuntimeSandboxProvisioner implements SandboxProvisioner {
	provision(input: SandboxProvisionInput): Promise<SandboxProvisionResult> {
		return provisionSessionSandboxWithRetry(input);
	}
}

export class OpenShellSandboxRuntimeInventory implements SandboxRuntimeInventory {
	async listSandboxes(): Promise<SandboxRuntimeRecord[]> {
		const res = await openshellRuntimeFetch("/api/v1/sandboxes");
		if (!res.ok) return [];
		const data = await res.json();
		return normalizeSandboxResponse(data) as SandboxRuntimeRecord[];
	}
}
