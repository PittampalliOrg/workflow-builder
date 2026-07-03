import { listRuntimes } from "$lib/server/agents/runtime-registry";
import { listTriggerKinds } from "$lib/server/workflows/trigger-registry";
import type {
	RuntimeCatalogReader,
	RuntimeCatalogItem,
	WorkflowTriggerKindCatalogReader,
	WorkflowTriggerKindReadModel,
} from "$lib/server/application/catalogs";

export class LocalRuntimeCatalogReader implements RuntimeCatalogReader {
	listRuntimes(): RuntimeCatalogItem[] {
		return listRuntimes().map((runtime) => ({
			id: runtime.id,
			family: runtime.family,
			cliAdapter: runtime.cliAdapter ?? null,
			capabilities: runtime.capabilities as unknown as Record<string, unknown>,
			cliAuth: runtime.cliAuth
				? {
						provider: runtime.cliAuth.provider,
						credentialKind: runtime.cliAuth.credentialKind,
						loginStyle: runtime.cliAuth.loginStyle ?? null,
					}
				: null,
		}));
	}
}

export class LocalWorkflowTriggerKindCatalogReader
	implements WorkflowTriggerKindCatalogReader
{
	listTriggerKinds(): WorkflowTriggerKindReadModel[] {
		return listTriggerKinds().map((kind) => ({
			id: kind.id,
			label: kind.label,
			icon: kind.icon,
			description: kind.description,
			backing: kind.backing,
			configSchema: kind.configSchema.map((field) => ({ ...field })),
			requiresActivation: kind.requiresActivation,
		}));
	}
}
