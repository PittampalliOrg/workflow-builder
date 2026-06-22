/**
 * Trigger backing provisioners — render + apply/delete the Kubernetes resources
 * that make a trigger "fire on signal", per the trigger kind's `backing`.
 *
 * This module implements the `argo-eventsource` backing (webhook/github/resource)
 * — the dev-verified pattern: an Argo Events EventSource + a Sensor whose HTTP
 * trigger POSTs the BFF ingest route, which republishes to `workflow.triggers`
 * (so idempotency + the concurrency gate apply uniformly on the spine).
 *
 * Resources are server-side-applied (idempotent reconcile) into the argo-events
 * namespace via the in-cluster kube API. The internal-token secret
 * (`wfb-internal-token`) must exist in that namespace (GitOps; created on dev).
 *
 * dapr-job / dapr-subscription / dapr-binding backings are P5/P6 — not yet here.
 */
import { kubeApiFetch } from '$lib/server/kube/client';
import { getTriggerKind } from '$lib/server/workflows/trigger-registry';
import { env } from '$env/dynamic/private';

const ARGO_NS = (env.ARGO_EVENTS_NAMESPACE ?? process.env.ARGO_EVENTS_NAMESPACE ?? 'argo-events').trim();
const INTERNAL_TOKEN_SECRET = (
	env.ARGO_EVENTS_INTERNAL_TOKEN_SECRET ?? process.env.ARGO_EVENTS_INTERNAL_TOKEN_SECRET ?? 'wfb-internal-token'
).trim();
const INGEST_URL =
	(env.WORKFLOW_TRIGGERS_INGEST_URL ?? process.env.WORKFLOW_TRIGGERS_INGEST_URL ?? '').trim() ||
	'http://workflow-builder.workflow-builder.svc.cluster.local:3000/api/internal/workflows/triggers/ingest';
const FIELD_MANAGER = 'wfb-trigger-reconciler';

/** Stable, DNS-safe resource name for a trigger's Argo objects. */
export function argoResourceName(triggerId: string): string {
	const safe = triggerId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
	return `wft-${safe || 'trigger'}`;
}

interface BackingContext {
	triggerId: string;
	workflowId: string;
	kind: string;
	config: Record<string, unknown>;
}

function eventSourceSpec(name: string, ctx: BackingContext): Record<string, unknown> | null {
	const cfg = ctx.config;
	const str = (k: string, d = '') => (typeof cfg[k] === 'string' ? (cfg[k] as string) : d);
	if (ctx.kind === 'webhook') {
		return {
			service: { ports: [{ port: 12000, targetPort: 12000 }] },
			webhook: {
				trigger: { port: '12000', endpoint: str('path', '/trigger'), method: str('method', 'POST') }
			}
		};
	}
	if (ctx.kind === 'github') {
		return {
			github: {
				trigger: {
					owner: str('owner'),
					repository: str('repo'),
					events: str('events', 'push').split(',').map((s) => s.trim()).filter(Boolean),
					webhook: { endpoint: '/push', port: '12000', method: 'POST', url: '' }
				}
			}
		};
	}
	if (ctx.kind === 'resource') {
		return {
			resource: {
				trigger: {
					group: str('group', ''),
					version: str('version', 'v1'),
					resource: str('resource'),
					namespace: str('namespace', ''),
					eventTypes: str('eventTypes', 'ADD,UPDATE').split(',').map((s) => s.trim()).filter(Boolean)
				}
			}
		};
	}
	return null;
}

function sensorManifest(name: string, esEventName: string, ctx: BackingContext): Record<string, unknown> {
	return {
		apiVersion: 'argoproj.io/v1alpha1',
		kind: 'Sensor',
		metadata: { name, namespace: ARGO_NS, labels: { 'app.kubernetes.io/managed-by': FIELD_MANAGER, 'workflow-builder.io/trigger-id': ctx.triggerId } },
		spec: {
			eventBusName: 'default',
			dependencies: [{ name: 'dep', eventSourceName: name, eventName: esEventName }],
			triggers: [
				{
					template: {
						name: 'start-workflow',
						conditions: 'dep',
						http: {
							url: INGEST_URL,
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							secureHeaders: [
								{ name: 'X-Internal-Token', valueFrom: { secretKeyRef: { name: INTERNAL_TOKEN_SECRET, key: 'token' } } }
							],
							payload: [
								{ src: { dependencyName: 'dep', value: ctx.workflowId }, dest: 'workflowId' },
								{ src: { dependencyName: 'dep', value: ctx.triggerId }, dest: 'triggerId' },
								{ src: { dependencyName: 'dep', contextKey: 'id', value: '' }, dest: 'dedupKey' },
								{ src: { dependencyName: 'dep', dataKey: 'body', value: '' }, dest: 'triggerData.event' }
							]
							// NOTE: http.timeout is an int64 — never a string ("30s" breaks
							// the Argo controller's ability to list ALL sensors); omitted here.
						}
					},
					retryStrategy: { steps: 3, duration: '3s', factor: 2 },
					policy: { status: { allow: [200, 201, 202] } }
				}
			]
		}
	};
}

function eventSourceManifest(name: string, spec: Record<string, unknown>, ctx: BackingContext): Record<string, unknown> {
	return {
		apiVersion: 'argoproj.io/v1alpha1',
		kind: 'EventSource',
		metadata: { name, namespace: ARGO_NS, labels: { 'app.kubernetes.io/managed-by': FIELD_MANAGER, 'workflow-builder.io/trigger-id': ctx.triggerId } },
		spec: { eventBusName: 'default', ...spec }
	};
}

async function ssaApply(plural: string, name: string, manifest: Record<string, unknown>): Promise<void> {
	const path = `/apis/argoproj.io/v1alpha1/namespaces/${ARGO_NS}/${plural}/${name}?fieldManager=${FIELD_MANAGER}&force=true`;
	const res = await kubeApiFetch(path, {
		method: 'PATCH',
		headers: { 'content-type': 'application/apply-patch+yaml' },
		body: JSON.stringify(manifest)
	});
	if (!res.ok && res.status !== 409) {
		const text = await res.text().catch(() => '');
		throw new Error(`apply ${plural}/${name} failed (${res.status}): ${text.slice(0, 300)}`);
	}
}

async function ssaDelete(plural: string, name: string): Promise<void> {
	const path = `/apis/argoproj.io/v1alpha1/namespaces/${ARGO_NS}/${plural}/${name}`;
	const res = await kubeApiFetch(path, { method: 'DELETE' });
	if (!res.ok && res.status !== 404) {
		const text = await res.text().catch(() => '');
		throw new Error(`delete ${plural}/${name} failed (${res.status}): ${text.slice(0, 300)}`);
	}
}

/** The Argo EventSource emits events under `<eventSourceName>.<eventName>`; the
 *  eventName equals the source-type's trigger key in the spec. */
function eventNameFor(kind: string): string {
	if (kind === 'webhook') return 'trigger';
	if (kind === 'github') return 'trigger';
	if (kind === 'resource') return 'trigger';
	return 'trigger';
}

export async function provisionBacking(ctx: BackingContext): Promise<{ backingRef: string }> {
	const kind = getTriggerKind(ctx.kind);
	if (!kind) throw new Error(`unknown trigger kind: ${ctx.kind}`);
	if (kind.backing !== 'argo-eventsource') {
		throw new Error(
			`backing '${kind.backing}' for kind '${ctx.kind}' is not yet implemented (P5/P6: dapr-job/subscription/binding)`
		);
	}
	const name = argoResourceName(ctx.triggerId);
	const spec = eventSourceSpec(name, ctx);
	if (!spec) throw new Error(`no EventSource spec for kind '${ctx.kind}'`);
	await ssaApply('eventsources', name, eventSourceManifest(name, spec, ctx));
	await ssaApply('sensors', name, sensorManifest(name, eventNameFor(ctx.kind), ctx));
	return { backingRef: `argo:${ARGO_NS}/${name}` };
}

export async function deprovisionBacking(ctx: { triggerId: string }): Promise<void> {
	const name = argoResourceName(ctx.triggerId);
	// Sensor first (it depends on the EventSource), then the EventSource.
	await ssaDelete('sensors', name);
	await ssaDelete('eventsources', name);
}
