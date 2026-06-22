/**
 * Trigger-kind registry — the SSOT for the workflow trigger categories the UI
 * exposes and the activation reconciler provisions. One typed catalog drives the
 * trigger-node config panel (which fields to render), validation, and which
 * backing mechanism each kind activates.
 *
 * BFF-only (the UI + the reconciler consume it; no Python service does), so it's a
 * typed module rather than a cross-service-vendored JSON like runtime-registry.
 *
 * Backing → "fire on signal" mechanism (see docs/event-driven-workflow-triggers.md):
 *   - none            → started by the user (Manual) or an existing surface (MCP).
 *   - dapr-job        → Dapr Jobs API / Scheduler (durable, replica-dedup).      [schedule]
 *   - dapr-subscription→ declarative Subscription routing a topic to the spine.    [topic]
 *   - dapr-binding    → Dapr input binding (Kafka/SQS/MQTT/…).                     [queue]
 *   - argo-eventsource→ Argo Events EventSource + Sensor (webhook/github/…).      [the long tail]
 * Every backing ultimately publishes to `workflow.triggers` → the start spine.
 */

export type TriggerBacking =
	| 'none'
	| 'dapr-job'
	| 'dapr-subscription'
	| 'dapr-binding'
	| 'argo-eventsource';

export type TriggerFieldType = 'string' | 'number' | 'boolean' | 'select' | 'cron' | 'textarea';

export interface TriggerConfigField {
	key: string;
	label: string;
	type: TriggerFieldType;
	required?: boolean;
	default?: string | number | boolean;
	placeholder?: string;
	help?: string;
	options?: { value: string; label: string }[];
}

export interface TriggerKind {
	id: string;
	label: string;
	icon: string;
	description: string;
	backing: TriggerBacking;
	/** Fields the UI renders + validates for this kind (data-driven config panel). */
	configSchema: TriggerConfigField[];
	/** Whether this kind needs an Active toggle (provisions a backing resource). */
	requiresActivation: boolean;
}

export const TRIGGER_KINDS: Record<string, TriggerKind> = {
	manual: {
		id: 'manual',
		label: 'Manual',
		icon: 'play',
		description: 'Run on demand from the UI or the execute API.',
		backing: 'none',
		configSchema: [],
		requiresActivation: false
	},
	mcp: {
		id: 'mcp',
		label: 'MCP tool',
		icon: 'plug',
		description: 'Exposed as an MCP tool; an MCP client invokes it.',
		backing: 'none',
		configSchema: [
			{ key: 'toolName', label: 'Tool name', type: 'string', required: true },
			{ key: 'toolDescription', label: 'Tool description', type: 'textarea' }
		],
		requiresActivation: false
	},
	webhook: {
		id: 'webhook',
		label: 'Webhook',
		icon: 'webhook',
		description: 'An external system POSTs a payload to a generated webhook URL.',
		backing: 'argo-eventsource',
		configSchema: [
			{
				key: 'path',
				label: 'Endpoint path',
				type: 'string',
				default: '/trigger',
				help: 'Path the EventSource listens on.'
			},
			{
				key: 'method',
				label: 'Method',
				type: 'select',
				default: 'POST',
				options: [
					{ value: 'POST', label: 'POST' },
					{ value: 'PUT', label: 'PUT' }
				]
			}
		],
		requiresActivation: true
	},
	schedule: {
		id: 'schedule',
		label: 'Schedule',
		icon: 'clock',
		description: 'Fire on a cron schedule or interval (Dapr Jobs/Scheduler).',
		backing: 'dapr-job',
		configSchema: [
			{
				key: 'schedule',
				label: 'Schedule',
				type: 'cron',
				required: true,
				placeholder: '@every 1h  or  0 30 3 * * *',
				help: 'Cron (6-field) or @every/@daily/@hourly.'
			},
			{ key: 'timezone', label: 'Timezone', type: 'string', placeholder: 'America/New_York' }
		],
		requiresActivation: true
	},
	topic: {
		id: 'topic',
		label: 'Event / Topic',
		icon: 'radio',
		description: 'Fire when a message lands on a pub/sub topic (Dapr Subscription).',
		backing: 'dapr-subscription',
		configSchema: [
			{ key: 'pubsubName', label: 'Pub/sub component', type: 'string', required: true, default: 'pubsub' },
			{ key: 'topic', label: 'Topic', type: 'string', required: true },
			{ key: 'match', label: 'CEL match (optional)', type: 'string', placeholder: 'event.type == "deploy.requested"' }
		],
		requiresActivation: true
	},
	queue: {
		id: 'queue',
		label: 'Cloud queue',
		icon: 'inbox',
		description: 'Fire on a message from Kafka / SQS / RabbitMQ / … (Dapr input binding).',
		backing: 'dapr-binding',
		configSchema: [
			{
				key: 'bindingType',
				label: 'Binding type',
				type: 'select',
				required: true,
				options: [
					{ value: 'bindings.kafka', label: 'Kafka' },
					{ value: 'bindings.aws.sqs', label: 'AWS SQS' },
					{ value: 'bindings.rabbitmq', label: 'RabbitMQ' },
					{ value: 'bindings.mqtt3', label: 'MQTT' },
					{ value: 'bindings.gcp.pubsub', label: 'GCP Pub/Sub' },
					{ value: 'bindings.azure.servicebusqueues', label: 'Azure Service Bus' }
				]
			},
			{ key: 'connection', label: 'Connection / brokers', type: 'string', required: true },
			{ key: 'topic', label: 'Topic / queue', type: 'string', required: true }
		],
		requiresActivation: true
	},
	github: {
		id: 'github',
		label: 'GitHub',
		icon: 'github',
		description: 'Fire on GitHub repo events (Argo Events GitHub EventSource).',
		backing: 'argo-eventsource',
		configSchema: [
			{ key: 'owner', label: 'Owner', type: 'string', required: true },
			{ key: 'repo', label: 'Repository', type: 'string', required: true },
			{ key: 'events', label: 'Events (comma-separated)', type: 'string', default: 'push', placeholder: 'push, pull_request' }
		],
		requiresActivation: true
	},
	resource: {
		id: 'resource',
		label: 'K8s resource',
		icon: 'box',
		description: 'Fire when a Kubernetes object changes (Argo Events Resource EventSource).',
		backing: 'argo-eventsource',
		configSchema: [
			{ key: 'group', label: 'API group', type: 'string', placeholder: 'apps' },
			{ key: 'version', label: 'Version', type: 'string', required: true, default: 'v1' },
			{ key: 'resource', label: 'Resource', type: 'string', required: true, placeholder: 'deployments' },
			{ key: 'namespace', label: 'Namespace', type: 'string' },
			{
				key: 'eventTypes',
				label: 'Event types',
				type: 'string',
				default: 'ADD,UPDATE',
				placeholder: 'ADD,UPDATE,DELETE'
			}
		],
		requiresActivation: true
	}
};

export type TriggerKindId = keyof typeof TRIGGER_KINDS;

export function getTriggerKind(id: string | null | undefined): TriggerKind | null {
	if (!id) return null;
	return TRIGGER_KINDS[id] ?? null;
}

export function listTriggerKinds(): TriggerKind[] {
	return Object.values(TRIGGER_KINDS);
}

/** Validate a trigger config against its kind's schema. Returns missing/invalid field keys. */
export function validateTriggerConfig(
	kindId: string,
	config: Record<string, unknown> | null | undefined
): { ok: boolean; missing: string[] } {
	const kind = getTriggerKind(kindId);
	if (!kind) return { ok: false, missing: ['__kind__'] };
	const cfg = config ?? {};
	const missing = kind.configSchema
		.filter((f) => f.required)
		.filter((f) => {
			const v = cfg[f.key];
			return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
		})
		.map((f) => f.key);
	return { ok: missing.length === 0, missing };
}
