import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	createFile,
	listFiles,
	MAX_UPLOAD_BYTES,
} from "$lib/server/files/registry";

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const purpose = url.searchParams.get("purpose");
	const scopeId = url.searchParams.get("scopeId");
	const files = await listFiles({
		userId: locals.session.userId,
		purpose:
			purpose === "agent" || purpose === "output"
				? (purpose as "agent" | "output")
				: undefined,
		scopeId: scopeId ?? undefined,
	});
	return json({ files });
};

/**
 * Multipart upload. Wire shape:
 *   form-data:
 *     file: <binary>        required
 *     purpose: agent|output (default: agent)
 *     scopeId: <session id> (required when purpose=output)
 *     name: <override>      (default: file.name)
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.startsWith("multipart/form-data")) {
		return error(400, "multipart/form-data body required");
	}

	const form = await request.formData();
	const file = form.get("file");
	if (!(file instanceof File)) {
		return error(400, "missing `file` field");
	}
	if (file.size > MAX_UPLOAD_BYTES) {
		return error(413, `file exceeds ${MAX_UPLOAD_BYTES} byte limit`);
	}

	const purposeRaw = (form.get("purpose") ?? "agent").toString();
	if (purposeRaw !== "agent" && purposeRaw !== "output") {
		return error(400, "purpose must be 'agent' or 'output'");
	}
	const purpose = purposeRaw as "agent" | "output";

	const scopeId = form.get("scopeId")?.toString() || null;
	if (purpose === "output" && !scopeId) {
		return error(400, "purpose='output' requires scopeId (session id)");
	}

	const nameOverride = form.get("name")?.toString();
	const bytes = Buffer.from(await file.arrayBuffer());

	const created = await createFile({
		userId: locals.session.userId,
		name: nameOverride || file.name || `upload-${Date.now()}`,
		purpose,
		scopeId,
		contentType: file.type || null,
		bytes,
	});

	return json({ file: created }, { status: 201 });
};
