import { getApplicationAdapters } from "$lib/server/application";
import type {
	CreateWorkflowFileInput,
	ListWorkflowFilesFilter,
	WorkflowFileRecord,
} from "$lib/server/application/ports";

export type FileSummary = WorkflowFileRecord;
export type CreateFileInput = CreateWorkflowFileInput;
export type ListFilesFilter = ListWorkflowFilesFilter;

/**
 * Hard cap on uploaded bytes, enforced in the handler. Agent-written outputs
 * usually fit well below this. The runtime's chunked-read path can produce
 * up to 100 MB base64 payloads, but the BFF's per-request body stays capped
 * here to keep POSTs bounded. Raise in future work if needed alongside a
 * multipart streaming endpoint.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function createFile(
	input: CreateFileInput,
): Promise<{ file: FileSummary; deduplicated: boolean }> {
	return getApplicationAdapters().workflowData.createWorkflowFile(input);
}

export async function listFiles(filter: ListFilesFilter): Promise<FileSummary[]> {
	return getApplicationAdapters().workflowData.listWorkflowFiles(filter);
}

export async function getFile(id: string): Promise<FileSummary | null> {
	return getApplicationAdapters().workflowData.getWorkflowFile(id);
}

export async function getFileContent(
	id: string,
): Promise<{ summary: FileSummary; bytes: Buffer } | null> {
	return getApplicationAdapters().workflowData.getWorkflowFileContent(id);
}

export async function archiveFile(
	id: string,
	userId: string,
): Promise<boolean> {
	return getApplicationAdapters().workflowData.archiveWorkflowFile({ id, userId });
}

export async function deleteFile(id: string, userId: string): Promise<boolean> {
	return getApplicationAdapters().workflowData.deleteWorkflowFile({ id, userId });
}
