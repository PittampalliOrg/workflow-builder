/**
 * Dapr state management with ETag-based optimistic concurrency.
 * Mirrors Python DaprInfra state methods at components.py:199-296.
 */

import {
	type DaprClient,
	StateConcurrencyEnum,
	StateConsistencyEnum,
} from "@dapr/dapr";
import type { AgentWorkflowState, AgentWorkflowEntry } from "../types/state.js";
import { withEtagRetry } from "./etag-retry.js";

/** Default empty state. */
function defaultState(): AgentWorkflowState {
	return { instances: {} };
}

function isNonEmptyString(value: string | null | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function mergeMessages(
	current: AgentWorkflowEntry["messages"],
	next: AgentWorkflowEntry["messages"],
): AgentWorkflowEntry["messages"] {
	const merged: AgentWorkflowEntry["messages"] = [];
	const seen = new Set<string>();
	for (const message of [...current, ...next]) {
		const key =
			message.id ||
			[
				message.role,
				message.tool_call_id || "",
				message.name || "",
				message.timestamp || "",
				message.content || "",
			].join("::");
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(message);
	}
	return merged;
}

function mergeToolHistory(
	current: AgentWorkflowEntry["tool_history"],
	next: AgentWorkflowEntry["tool_history"],
): AgentWorkflowEntry["tool_history"] {
	const merged: AgentWorkflowEntry["tool_history"] = [];
	const seen = new Set<string>();
	for (const record of [...current, ...next]) {
		const key =
			record.id ||
			[
				record.tool_call_id,
				record.tool_name,
				record.timestamp,
				record.execution_result,
			].join("::");
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(record);
	}
	return merged;
}

function mergeEntry(
	current: AgentWorkflowEntry,
	next: AgentWorkflowEntry,
): AgentWorkflowEntry {
	const messages = mergeMessages(current.messages, next.messages);
	const systemMessages = mergeMessages(
		current.system_messages,
		next.system_messages,
	);
	const toolHistory = mergeToolHistory(current.tool_history, next.tool_history);
	return {
		...current,
		...next,
		input_value:
			isNonEmptyString(next.input_value) &&
			next.input_value !== "Recovered workflow state"
				? next.input_value
				: current.input_value,
		output: next.output ?? current.output,
		end_time: next.end_time ?? current.end_time,
		messages,
		system_messages: systemMessages,
		last_message:
			next.last_message ??
			current.last_message ??
			(messages.length > 0 ? messages[messages.length - 1] : null),
		tool_history: toolHistory,
		source: next.source ?? current.source,
		workflow_instance_id:
			next.workflow_instance_id ?? current.workflow_instance_id,
		triggering_workflow_instance_id:
			next.triggering_workflow_instance_id ??
			current.triggering_workflow_instance_id,
		workflow_name: next.workflow_name ?? current.workflow_name,
		session_id: next.session_id ?? current.session_id,
		trace_context:
			next.trace_context && current.trace_context
				? { ...current.trace_context, ...next.trace_context }
				: (next.trace_context ?? current.trace_context),
		status:
			current.status !== "running" && next.status === "running"
				? current.status
				: next.status,
	};
}

function mergeStates(
	current: AgentWorkflowState,
	next: AgentWorkflowState,
): AgentWorkflowState {
	const instances: AgentWorkflowState["instances"] = { ...current.instances };
	for (const [instanceId, nextEntry] of Object.entries(next.instances)) {
		const currentEntry = instances[instanceId];
		instances[instanceId] = currentEntry
			? mergeEntry(currentEntry, nextEntry)
			: nextEntry;
	}
	return {
		instances,
	};
}

/** Default workflow entry factory. */
function defaultEntry(
	instanceId: string,
	inputValue: string,
	triggeringWorkflowInstanceId?: string | null,
): AgentWorkflowEntry {
	return {
		input_value: inputValue,
		output: null,
		start_time: new Date().toISOString(),
		end_time: null,
		messages: [],
		system_messages: [],
		last_message: null,
		tool_history: [],
		source: null,
		workflow_instance_id: instanceId,
		triggering_workflow_instance_id: triggeringWorkflowInstanceId ?? null,
		workflow_name: "agentWorkflow",
		session_id: null,
		trace_context: null,
		status: "running",
	};
}

export class DaprAgentState {
	private client: DaprClient;
	private storeName: string;
	private stateKey: string;
	private maxEtagAttempts: number;
	private readonly stateBaseUrl: string;

	constructor(
		client: DaprClient,
		storeName: string,
		stateKey: string,
		maxEtagAttempts: number = 10,
	) {
		this.client = client;
		this.storeName = storeName;
		this.stateKey = stateKey;
		this.maxEtagAttempts = maxEtagAttempts;
		const host = process.env.DAPR_HOST?.trim() || "127.0.0.1";
		const port = process.env.DAPR_HTTP_PORT?.trim() || "3500";
		this.stateBaseUrl = `http://${host}:${port}/v1.0/state/${this.storeName}`;
	}

	/** Load the full agent state from the Dapr state store. */
	async loadState(): Promise<AgentWorkflowState> {
		const { state } = await this.loadStateSnapshot();
		return state;
	}

	/**
	 * Persist the full agent state with optimistic concurrency.
	 * Uses ETag retry loop to handle concurrent modifications.
	 * Mirrors Python save_state at components.py:225-288.
	 */
	async saveState(state: AgentWorkflowState): Promise<void> {
		await withEtagRetry(async () => {
			const snapshot = await this.loadStateSnapshot();
			const mergedState = mergeStates(snapshot.state, state);
			const response = await this.client.state.save(this.storeName, [
				{
					key: this.stateKey,
					value: mergedState,
					...(snapshot.etag ? { etag: snapshot.etag } : {}),
					options: {
						concurrency: StateConcurrencyEnum.CONCURRENCY_FIRST_WRITE,
						consistency: StateConsistencyEnum.CONSISTENCY_STRONG,
					},
				},
			]);
			if (response?.error) {
				throw response.error;
			}
		}, this.maxEtagAttempts);
	}

	/**
	 * Ensure an instance entry exists for the given workflow instance ID.
	 * Creates a new entry if one doesn't exist; no-op if it already does.
	 * Mirrors Python ensure_instance_exists at components.py:298-348.
	 */
	async ensureInstance(
		instanceId: string,
		inputValue: string,
		triggeringWorkflowInstanceId?: string | null,
	): Promise<AgentWorkflowState> {
		const state = await this.loadState();
		if (!state.instances[instanceId]) {
			state.instances[instanceId] = defaultEntry(
				instanceId,
				inputValue,
				triggeringWorkflowInstanceId,
			);
			await this.saveState(state);
		}
		return state;
	}

	private async loadStateSnapshot(): Promise<{
		state: AgentWorkflowState;
		etag?: string;
	}> {
		const response = await fetch(
			`${this.stateBaseUrl}/${encodeURIComponent(this.stateKey)}?consistency=strong`,
		);
		if (response.status === 204 || response.status === 404) {
			return { state: defaultState() };
		}
		if (!response.ok) {
			throw new Error(
				`Failed to load state ${this.stateKey}: ${response.status} ${response.statusText}`,
			);
		}

		const rawText = await response.text();
		const etagHeader = response.headers.get("etag")?.trim();
		const etag = etagHeader
			? etagHeader.replace(/^W\//, "").replace(/^"|"$/g, "")
			: undefined;

		if (!rawText.trim()) {
			return { state: defaultState(), ...(etag ? { etag } : {}) };
		}

		try {
			return {
				state: JSON.parse(rawText) as AgentWorkflowState,
				...(etag ? { etag } : {}),
			};
		} catch (error) {
			throw new Error(
				`Failed to parse state ${this.stateKey}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
