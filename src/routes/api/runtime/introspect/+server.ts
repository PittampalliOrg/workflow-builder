import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { daprFetch, getWorkflowCapableServices } from '$lib/server/dapr-client';
import { createHighlighter, type Highlighter } from 'shiki';

// ---------------------------------------------------------------------------
// Shiki highlighter (lazily initialized, reused across requests)
// ---------------------------------------------------------------------------

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter({
			themes: ['github-dark'],
			langs: ['python', 'typescript'],
		});
	}
	return highlighterPromise;
}

async function highlightCode(code: string, runtime: string): Promise<string> {
	try {
		const h = await getHighlighter();
		const lang = runtime.includes('python') ? 'python' : 'typescript';
		return h.codeToHtml(code, { lang, theme: 'github-dark' });
	} catch {
		return '';
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NormalizedActivity {
	name: string;
	service: string;
	source: string;
	sourceCode?: string | null;
	sourceHtml?: string | null;
	doc?: string | null;
}

interface NormalizedWorkflow {
	name: string;
	version: string | null;
	aliases: string[];
	isLatest: boolean;
	service: string;
	source: string;
}

interface ServiceIntrospection {
	service: string;
	version: string;
	runtime: string;
	ready: boolean;
	features: string[];
	registeredWorkflows: NormalizedWorkflow[];
	registeredActivities: NormalizedActivity[];
	additional: Record<string, unknown>;
}

interface UnifiedIntrospectResponse {
	timestamp: string;
	services: ServiceIntrospection[];
	allActivities: NormalizedActivity[];
	allWorkflows: NormalizedWorkflow[];
	partialErrors: { serviceId: string; error: string }[];
}

// ---------------------------------------------------------------------------
// Cache (registrations change only at deploy time)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000;
let cachedResponse: UnifiedIntrospectResponse | null = null;
let cacheTimestamp = 0;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const GET: RequestHandler = async ({ url }) => {
	const refresh = url.searchParams.get('refresh') === 'true';

	if (!refresh && cachedResponse && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
		return json(cachedResponse);
	}

	const services = getWorkflowCapableServices();

	const results = await Promise.allSettled(
		services.map(async (svc) => {
			const endpoint = `${svc.getBaseUrl()}${svc.introspectPath}`;
			const res = await daprFetch(endpoint, { maxRetries: 1 });
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} from ${svc.id}`);
			}
			return { serviceId: svc.id, data: (await res.json()) as Record<string, unknown> };
		})
	);

	const serviceIntrospections: ServiceIntrospection[] = [];
	const allActivities: NormalizedActivity[] = [];
	const allWorkflows: NormalizedWorkflow[] = [];
	const partialErrors: { serviceId: string; error: string }[] = [];

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const serviceId = services[i].id;

		if (result.status === 'rejected') {
			partialErrors.push({
				serviceId,
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
			continue;
		}

		const raw = result.value.data;

		// Normalize activities (with syntax highlighting)
		const rawRuntime = String(raw.runtime || '');
		const rawActivities = Array.isArray(raw.registeredActivities)
			? (raw.registeredActivities as { name: string; source?: string; sourceCode?: string | null; doc?: string | null }[])
			: [];
		const activities: NormalizedActivity[] = await Promise.all(
			rawActivities.map(async (a) => ({
				name: a.name,
				service: serviceId,
				source: a.source || 'service-introspection',
				...(a.sourceCode ? { sourceCode: a.sourceCode, sourceHtml: await highlightCode(a.sourceCode, rawRuntime) } : {}),
				...(a.doc ? { doc: a.doc } : {}),
			}))
		);

		// Normalize workflows
		const rawWorkflows = Array.isArray(raw.registeredWorkflows)
			? (raw.registeredWorkflows as {
					name: string;
					version?: string;
					aliases?: string[];
					isLatest?: boolean;
					source?: string;
				}[])
			: [];
		const workflows: NormalizedWorkflow[] = rawWorkflows.map((w) => ({
			name: w.name,
			version: w.version ?? null,
			aliases: w.aliases ?? [],
			isLatest: w.isLatest ?? false,
			service: serviceId,
			source: w.source || 'service-introspection',
		}));

		serviceIntrospections.push({
			service: String(raw.service || serviceId),
			version: String(raw.version || 'unknown'),
			runtime: String(raw.runtime || 'unknown'),
			ready: Boolean(raw.ready),
			features: Array.isArray(raw.features) ? (raw.features as string[]) : [],
			registeredWorkflows: workflows,
			registeredActivities: activities,
			additional: (raw.additional as Record<string, unknown>) ?? {},
		});

		allActivities.push(...activities);
		allWorkflows.push(...workflows);
	}

	const response: UnifiedIntrospectResponse = {
		timestamp: new Date().toISOString(),
		services: serviceIntrospections,
		allActivities,
		allWorkflows,
		partialErrors,
	};

	cachedResponse = response;
	cacheTimestamp = Date.now();

	return json(response);
};
