import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
	deriveCodeFunctionDependencies,
	getCodeFunction,
	getCodeFunctionBySlug,
	type CodeFunctionDetail,
} from '$lib/server/code-functions';
import { daprFetch, getCodeRuntimeUrl } from '$lib/server/dapr-client';

type FunctionRef = {
	id?: string;
	slug?: string;
	version?: string;
};

type DynamicOption = {
	label: string;
	value: unknown;
};

function parseFunctionRef(value: unknown): FunctionRef | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}

	const candidate = value as Record<string, unknown>;
	const ref: FunctionRef = {};
	if (typeof candidate.id === 'string' && candidate.id.trim()) {
		ref.id = candidate.id.trim();
	}
	if (typeof candidate.slug === 'string' && candidate.slug.trim()) {
		ref.slug = candidate.slug.trim();
	}
	if (typeof candidate.version === 'string' && candidate.version.trim()) {
		ref.version = candidate.version.trim();
	}
	return ref.id || ref.slug ? ref : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDynamicOptions(value: unknown): DynamicOption[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const normalized: DynamicOption[] = [];

	for (const item of value) {
		if (isRecord(item)) {
			const label =
				(typeof item.label === 'string' && item.label) ||
				(typeof item.name === 'string' && item.name) ||
				(typeof item.displayName === 'string' && item.displayName) ||
				(typeof item.title === 'string' && item.title) ||
				(typeof item.value === 'string' && item.value) ||
				(typeof item.id === 'string' && item.id) ||
				null;
			const optionValue =
				item.value ??
				item.id ??
				item.externalId ??
				item.key ??
				item.name ??
				item.label;
			if (label && optionValue !== undefined) {
				normalized.push({ label, value: optionValue });
				continue;
			}
		}

		if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
			normalized.push({ label: String(item), value: item });
		}
	}

	return normalized;
}

function normalizeDynamicResult(value: unknown): {
	options: DynamicOption[];
	disabled?: boolean;
	placeholder?: string;
} {
	if (isRecord(value)) {
		return {
			options: normalizeDynamicOptions(value.options),
			disabled: value.disabled === true,
			placeholder: typeof value.placeholder === 'string' ? value.placeholder : undefined,
		};
	}

	return {
		options: normalizeDynamicOptions(value),
	};
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, 'Authentication required');
	}

	let body: Record<string, unknown> = {};
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const functionRef = parseFunctionRef(body.functionRef);
	if (!functionRef) {
		throw error(400, 'functionRef is required');
	}

	const field = typeof body.param === 'string' ? body.param.trim() : '';
	if (!field) {
		throw error(400, 'param is required');
	}

	let detail: CodeFunctionDetail | null = null;

	if (functionRef.slug && functionRef.version) {
		detail = await getCodeFunctionBySlug(
			functionRef.slug,
			functionRef.version,
			locals.session.userId,
		);
	}

	if (!detail && functionRef.id) {
		detail = await getCodeFunction(functionRef.id, locals.session.userId);
		if (
			detail &&
			functionRef.version &&
			functionRef.version !== detail.version &&
			functionRef.version !== detail.latestPublishedVersion
		) {
			detail =
				(await getCodeFunctionBySlug(
					detail.slug,
					functionRef.version,
					locals.session.userId,
				)) || detail;
		}
	}

	if (!detail && functionRef.slug && functionRef.version) {
		detail = await getCodeFunctionBySlug(
			functionRef.slug,
			functionRef.version,
			locals.session.userId,
		);
	}

	if (!detail) {
		throw error(404, 'Code function not found');
	}

	const dynamicInput =
		(detail.model.dynamic_inputs || []).find((item) => item.name === field) || null;
	if (!dynamicInput?.handler) {
		throw error(404, `No dynamic options handler configured for "${field}"`);
	}

	const input = isRecord(body.input) ? body.input : {};
	const searchValue =
		typeof body.searchValue === 'string'
			? body.searchValue
			: typeof body.search_value === 'string'
				? body.search_value
				: undefined;

	const response = await daprFetch(`${getCodeRuntimeUrl()}/options`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			language: detail.language,
			source: detail.source,
			handler: dynamicInput.handler,
			path: detail.path || undefined,
			supporting_files: detail.supportingFiles || {},
			input,
			dependencies: deriveCodeFunctionDependencies(detail.model),
			search_value: searchValue,
		}),
		maxRetries: 1,
	});

	const payload = (await response.json().catch(() => null)) as
		| {
				options?: unknown;
				disabled?: boolean;
				placeholder?: string;
				error?: string;
		  }
		| null;

	if (!response.ok || !payload) {
		throw error(response.status || 502, payload?.error || `Code runtime returned HTTP ${response.status}`);
	}

	const normalized = normalizeDynamicResult(payload);

	return json({
		options: normalized.options,
		disabled: normalized.disabled === true,
		placeholder: normalized.placeholder,
	});
};
