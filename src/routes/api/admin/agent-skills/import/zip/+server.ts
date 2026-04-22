import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	canManageAgentSkills,
	upsertCustomSkillFromZip,
	SkillBundleValidationError
} from '$lib/server/agent-skills';

// Matches the 4 MiB cap the plan commits to. If the cluster's ingress body
// limit is lower, that kicks in first — bump the nginx proxy-body-size
// annotation alongside this if needed.
const MAX_ZIP_BYTES = 4 * 1024 * 1024;

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	const projectId = locals.session.projectId;
	if (!projectId) return error(400, 'Active workspace is required');
	if (!(await canManageAgentSkills(locals.session.userId, projectId)))
		return error(403, 'Forbidden');

	let form: FormData;
	try {
		form = await request.formData();
	} catch (err) {
		return error(400, err instanceof Error ? err.message : 'Invalid multipart body');
	}

	const file = form.get('file');
	if (!(file instanceof Blob)) return error(400, 'file is required (multipart field)');
	if (file.size > MAX_ZIP_BYTES) {
		return error(413, `zip exceeds ${MAX_ZIP_BYTES} byte cap`);
	}

	const skillName = String(form.get('skillName') || '').trim();
	if (!skillName) return error(400, 'skillName is required');
	const slug = String(form.get('slug') || '').trim() || undefined;
	const statusRaw = String(form.get('status') || '').trim().toUpperCase();
	const status =
		statusRaw === 'ENABLED' || statusRaw === 'DISABLED' || statusRaw === 'DRAFT'
			? (statusRaw as 'ENABLED' | 'DISABLED' | 'DRAFT')
			: undefined;
	const description = String(form.get('description') || '').trim() || null;

	const buffer = Buffer.from(await file.arrayBuffer());
	try {
		const skill = await upsertCustomSkillFromZip({
			zipBuffer: buffer,
			skillName,
			slug,
			projectId,
			userId: locals.session.userId,
			status,
			description
		});
		return json({ skill });
	} catch (err) {
		if (err instanceof SkillBundleValidationError) return error(400, err.message);
		return error(400, err instanceof Error ? err.message : 'Failed to ingest zip bundle');
	}
};
