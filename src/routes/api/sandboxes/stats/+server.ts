import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';
import { normalizeSandboxResponse } from '$lib/utils/sandbox-parse';
import { db } from '$lib/server/db';
import { workflowExecutions } from '$lib/server/db/schema';
import { sql, gte } from 'drizzle-orm';

export const GET: RequestHandler = async () => {
	// Current sandboxes
	let sandboxes: Array<Record<string, string | undefined>> = [];
	try {
		const res = await openshellRuntimeFetch('/api/v1/sandboxes');
		if (res.ok) {
			const data = await res.json();
			sandboxes = normalizeSandboxResponse(data) as unknown as Array<Record<string, string | undefined>>;
		}
	} catch {
		// silent
	}

	const byPhase: Record<string, number> = {};
	for (const sb of sandboxes) {
		const phase = String(sb.phase ?? 'UNKNOWN');
		byPhase[phase] = (byPhase[phase] ?? 0) + 1;
	}

	// Execution count (last 24h)
	let executions24h = 0;
	if (db) {
		try {
			const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
			const [row] = await db
				.select({ count: sql<number>`count(*)` })
				.from(workflowExecutions)
				.where(gte(workflowExecutions.startedAt, cutoff));
			executions24h = Number(row?.count ?? 0);
		} catch {
			// silent
		}
	}

	// Average sandbox age
	let avgAgeMinutes = 0;
	if (sandboxes.length > 0) {
		const now = Date.now();
		const ages = sandboxes
			.map((sb) => {
				const created = sb.createdAt ? new Date(String(sb.createdAt)).getTime() : 0;
				return created > 0 ? (now - created) / 60000 : 0;
			})
			.filter((a) => a > 0);
		avgAgeMinutes = ages.length > 0 ? Math.round(ages.reduce((s, a) => s + a, 0) / ages.length) : 0;
	}

	return json({
		total: sandboxes.length,
		byPhase,
		executions24h,
		avgAgeMinutes
	});
};
