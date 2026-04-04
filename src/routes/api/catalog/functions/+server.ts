import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { daprFetch, getFnActivepiecesUrl } from '$lib/server/dapr-client';
import { db } from '$lib/server/db';
import { codeFunctions } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { toCodeCatalogFunction } from '$lib/server/code-functions';

let cachedApResponse: { functions?: unknown[]; count?: number; error?: string } | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000;

export const GET: RequestHandler = async ({ locals }) => {
	let apFunctions: unknown[] = [];
	let apError: string | null = null;
	try {
		if (cachedApResponse && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
			apFunctions = cachedApResponse.functions || [];
		} else {
			const res = await daprFetch(`${getFnActivepiecesUrl()}/catalog/functions`, { maxRetries: 1 });
			if (!res.ok) {
				apError = `HTTP ${res.status}`;
			} else {
				const data = await res.json();
				cachedApResponse = data;
				cacheTimestamp = Date.now();
				apFunctions = data.functions || [];
			}
		}
	} catch (err) {
		apError = String(err);
	}

	const codeRows = db
		&& locals.session?.userId
		? await db
				.select()
				.from(codeFunctions)
				.where(
					and(
						eq(codeFunctions.isEnabled, true),
						eq(codeFunctions.createdBy, locals.session.userId),
					),
				)
		: [];

	const functions = [
		...codeRows.map(toCodeCatalogFunction),
		...apFunctions,
	];

	return json({
		functions,
		count: functions.length,
		error: apError,
	});
};
