export type RuntimeCatalogItem = {
	id: string;
	family: string;
	cliAdapter: string | null;
	capabilities: Record<string, unknown>;
	cliAuth: {
		provider: string;
		credentialKind: string;
		loginStyle: string | null;
	} | null;
};

export type RuntimeCatalogReader = {
	listRuntimes(): RuntimeCatalogItem[];
};

export type TriggerConfigFieldReadModel = {
	key: string;
	label: string;
	type: string;
	required?: boolean;
	default?: string | number | boolean;
	placeholder?: string;
	help?: string;
	options?: { value: string; label: string }[];
};

export type WorkflowTriggerKindReadModel = {
	id: string;
	label: string;
	icon: string;
	description: string;
	backing: string;
	configSchema: TriggerConfigFieldReadModel[];
	requiresActivation: boolean;
};

export type WorkflowTriggerKindCatalogReader = {
	listTriggerKinds(): WorkflowTriggerKindReadModel[];
};

export class ApplicationRuntimeCatalogService {
	constructor(private readonly catalog: RuntimeCatalogReader) {}

	listRuntimes(): { runtimes: RuntimeCatalogItem[] } {
		return { runtimes: this.catalog.listRuntimes() };
	}
}

export class ApplicationWorkflowTriggerKindCatalogService {
	constructor(private readonly catalog: WorkflowTriggerKindCatalogReader) {}

	listKinds(): { kinds: WorkflowTriggerKindReadModel[] } {
		return { kinds: this.catalog.listTriggerKinds() };
	}
}
