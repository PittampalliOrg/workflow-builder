import { query } from "$app/server";
import { getApplicationAdapters } from "$lib/server/application";

export const getSidecarMetadata = query(async () => {
	return getApplicationAdapters().daprInspection.getSidecarMetadata();
});

export const getServiceHealth = query(async () => {
	return getApplicationAdapters().daprInspection.getServiceHealth();
});

export const getStateValue = query(
	"unchecked",
	async ({
		storeName,
		key,
		metadata,
	}: {
		storeName: string;
		key: string;
		metadata?: Record<string, string>;
	}) => {
		return getApplicationAdapters().daprInspection.getStateValue({
			storeName,
			key,
			metadata,
		});
	},
);

export const getKnownStateKeys = query(async () => {
	return getApplicationAdapters().daprInspection.getKnownStateKeys();
});

export const getWorkflowSummary = query(async () => {
	return getApplicationAdapters().daprInspection.getWorkflowSummary();
});

export const getWorkflowHistory = query("unchecked", async (instanceId: string) => {
	return getApplicationAdapters().daprInspection.getWorkflowHistory(instanceId);
});

export const getAgentRegistry = query(async () => {
	return getApplicationAdapters().daprInspection.getAgentRegistry();
});

export const getAgentDaprState = query(
	"unchecked",
	async ({
		agentName,
		storeName,
		stateKey,
		appId,
		instancesEndpoint,
	}: {
		agentName: string;
		storeName?: string | null;
		stateKey?: string | null;
		appId?: string | null;
		instancesEndpoint?: string | null;
	}) => {
		return getApplicationAdapters().daprInspection.getAgentDaprState({
			agentName,
			storeName,
			stateKey,
			appId,
			instancesEndpoint,
		});
	},
);
