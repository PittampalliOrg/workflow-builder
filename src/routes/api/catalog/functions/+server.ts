import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { codeFunctions } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { toCodeCatalogFunction } from '$lib/server/code-functions';
import { listPieceCatalogFunctions } from '$lib/server/action-catalog/piece-metadata-source';

export const GET: RequestHandler = async ({ locals }) => {
	let apFunctions: unknown[] = [];
	let apError: string | null = null;
	try {
		apFunctions = await listPieceCatalogFunctions();
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
