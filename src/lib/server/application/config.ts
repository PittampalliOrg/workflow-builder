import { env } from "$env/dynamic/private";

export const PERSISTENCE_ADAPTERS = ["postgres"] as const;
export const EVENT_BUS_ADAPTERS = ["dapr-pubsub"] as const;
export const ARTIFACT_STORE_ADAPTERS = ["postgres-metadata-object-data"] as const;
export const WORKFLOW_SCHEDULER_ADAPTERS = ["dapr-workflow"] as const;
export const PREVIEW_PROVISIONER_ADAPTERS = ["sandbox-execution-api", "kro"] as const;

export type PersistenceAdapter = (typeof PERSISTENCE_ADAPTERS)[number];
export type EventBusAdapter = (typeof EVENT_BUS_ADAPTERS)[number];
export type ArtifactStoreAdapter = (typeof ARTIFACT_STORE_ADAPTERS)[number];
export type WorkflowSchedulerAdapter = (typeof WORKFLOW_SCHEDULER_ADAPTERS)[number];
export type PreviewProvisionerAdapter = (typeof PREVIEW_PROVISIONER_ADAPTERS)[number];

export type ApplicationAdapterConfig = {
	persistenceAdapter: PersistenceAdapter;
	eventBusAdapter: EventBusAdapter;
	artifactStoreAdapter: ArtifactStoreAdapter;
	workflowSchedulerAdapter: WorkflowSchedulerAdapter;
	previewProvisionerAdapter: PreviewProvisionerAdapter;
};

function readAdapter<T extends string>(
	source: Record<string, string | undefined>,
	key: string,
	fallback: T,
	supported: readonly T[],
): T {
	const raw = source[key]?.trim();
	if (!raw) return fallback;
	if ((supported as readonly string[]).includes(raw)) return raw as T;
	throw new Error(
		`Unsupported ${key}='${raw}'. Supported values: ${supported.join(", ")}`,
	);
}

export function getApplicationAdapterConfig(
	source: Record<string, string | undefined> = env,
): ApplicationAdapterConfig {
	return {
		persistenceAdapter: readAdapter(
			source,
			"PERSISTENCE_ADAPTER",
			"postgres",
			PERSISTENCE_ADAPTERS,
		),
		eventBusAdapter: readAdapter(
			source,
			"EVENT_BUS_ADAPTER",
			"dapr-pubsub",
			EVENT_BUS_ADAPTERS,
		),
		artifactStoreAdapter: readAdapter(
			source,
			"ARTIFACT_STORE_ADAPTER",
			"postgres-metadata-object-data",
			ARTIFACT_STORE_ADAPTERS,
		),
		workflowSchedulerAdapter: readAdapter(
			source,
			"WORKFLOW_SCHEDULER_ADAPTER",
			"dapr-workflow",
			WORKFLOW_SCHEDULER_ADAPTERS,
		),
		previewProvisionerAdapter: readAdapter(
			source,
			"PREVIEW_PROVISIONER_ADAPTER",
			"sandbox-execution-api",
			PREVIEW_PROVISIONER_ADAPTERS,
		),
	};
}
