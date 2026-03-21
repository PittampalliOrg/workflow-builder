/**
 * Workflow UI Transform Functions
 *
 * Functions to transform internal database data to UI-compatible format.
 */

import type {
	Workflow,
	WorkflowExecution,
	WorkflowExecutionLog,
} from "@/lib/db/schema";
import type { DurableAgentRunSummary } from "@/lib/types/durable-timeline";
import type {
	DaprAgentTask,
	DaprExecutionEvent,
	DaprExecutionEventType,
	TokenUsage,
	TraceMetadata,
	WorkflowDetail,
	WorkflowListItem,
	WorkflowUIStatus,
} from "@/lib/types/workflow-ui";

// ============================================================================
// Timestamp Parsing
// ============================================================================

/**
 * Parse a timestamp that may be in ISO format or Date object.
 * workflow-builder uses ISO 8601 timestamps directly (no protobuf parsing needed)
 */
export function parseTimestamp(
	timestamp: string | Date | undefined | null,
): string {
	if (!timestamp) {
		return "";
	}

	// If it's already a Date object
	if (timestamp instanceof Date) {
		return timestamp.toISOString();
	}

	// ISO format string
	const date = new Date(timestamp);
	if (!Number.isNaN(date.getTime())) {
		return date.toISOString();
	}

	return "";
}

// ============================================================================
// Status Mapping
// ============================================================================

/**
 * Map internal workflow execution status to UI-compatible status
 */
export function mapWorkflowStatus(
	status: "pending" | "running" | "success" | "error" | "cancelled" | string,
): WorkflowUIStatus {
	const normalizedStatus = status?.toUpperCase?.() || status;

	switch (normalizedStatus) {
		case "PENDING":
			return "PENDING";
		case "RUNNING":
			return "RUNNING";
		case "SUSPENDED":
			return "SUSPENDED";
		case "SUCCESS":
		case "COMPLETED":
			return "COMPLETED";
		case "ERROR":
		case "FAILED":
			return "FAILED";
		case "TERMINATED":
			return "TERMINATED";
		case "CANCELED":
		case "CANCELLED":
			return "CANCELLED";
		default:
			return "RUNNING";
	}
}

// ============================================================================
// Event Type Mapping
// ============================================================================

/**
 * Map internal execution log status to Dapr event type
 */
export function mapExecutionLogEvent(
	status: "pending" | "running" | "success" | "error" | string,
): DaprExecutionEventType {
	switch (status) {
		case "pending":
			return "TaskScheduled";
		case "running":
			return "TaskScheduled";
		case "success":
			return "TaskCompleted";
		case "error":
			return "TaskCompleted";
		default:
			return "TaskCompleted";
	}
}

// ============================================================================
// Duration Calculation
// ============================================================================

/**
 * Calculate duration between two timestamps
 * Returns human-readable string like "1m 23s" or "45s"
 * Always uses seconds/minutes/hours (never milliseconds)
 */
export function calculateDuration(
	startTime: string | Date,
	endTime?: string | Date | null,
): string | null {
	if (!startTime) {
		return null;
	}

	const start = new Date(startTime).getTime();
	const end = endTime ? new Date(endTime).getTime() : Date.now();

	if (Number.isNaN(start) || Number.isNaN(end)) {
		return null;
	}

	const durationMs = end - start;

	// Less than 1 second
	if (durationMs < 1000) {
		return "< 1s";
	}

	// Less than 1 minute - show seconds
	if (durationMs < 60_000) {
		const seconds = Math.floor(durationMs / 1000);
		return `${seconds}s`;
	}

	// Less than 1 hour - show minutes and seconds
	if (durationMs < 3_600_000) {
		const minutes = Math.floor(durationMs / 60_000);
		const seconds = Math.floor((durationMs % 60_000) / 1000);
		if (seconds === 0) {
			return `${minutes}m`;
		}
		return `${minutes}m ${seconds}s`;
	}

	// 1 hour or more - show hours and minutes
	const hours = Math.floor(durationMs / 3_600_000);
	const minutes = Math.floor((durationMs % 3_600_000) / 60_000);
	if (minutes === 0) {
		return `${hours}h`;
	}
	return `${hours}h ${minutes}m`;
}

/**
 * Calculate elapsed time for an event
 * Always uses seconds/minutes/hours (never milliseconds)
 */
export function calculateElapsed(
	eventTimestamp: string | Date,
	referenceTimestamp: string | Date,
): string {
	const event = new Date(eventTimestamp).getTime();
	const reference = new Date(referenceTimestamp).getTime();

	if (Number.isNaN(event) || Number.isNaN(reference)) {
		return "-";
	}

	const elapsedMs = event - reference;

	// Less than 1 second
	if (elapsedMs < 1000) {
		return "< 1s";
	}

	// Less than 1 minute
	if (elapsedMs < 60_000) {
		const seconds = Math.floor(elapsedMs / 1000);
		return `${seconds}s`;
	}

	// Less than 1 hour
	if (elapsedMs < 3_600_000) {
		const minutes = Math.floor(elapsedMs / 60_000);
		const seconds = Math.floor((elapsedMs % 60_000) / 1000);
		if (seconds === 0) {
			return `${minutes}m`;
		}
		return `${minutes}m ${seconds}s`;
	}

	// 1 hour or more
	const hours = Math.floor(elapsedMs / 3_600_000);
	const minutes = Math.floor((elapsedMs % 3_600_000) / 60_000);
	if (minutes === 0) {
		return `${hours}h`;
	}
	return `${hours}h ${minutes}m`;
}

// ============================================================================
// Dapr Agent Output Parsing
// ============================================================================

/**
 * Dapr Agent Output structure
 */
export type DaprAgentOutput = {
	plan_text?: string;
	tasks?: DaprAgentTask[];
	usage?: TokenUsage;
	trace_id?: string;
	trace_metadata?: TraceMetadata;
};

export type ExecutionOutcomeSummary = {
	branch?: string;
	commit?: string;
	prNumber?: number | string;
	prUrl?: string;
	prState?: string;
	remote?: string;
	changedFileCount?: number;
};

export type ExecutionOutputFileChangeStatus = "A" | "M" | "D" | "R";

export type ExecutionOutputFileChangeEntry = {
	path: string;
	status: ExecutionOutputFileChangeStatus;
	oldPath?: string;
};

export type ExecutionOutputFileChangeSummary = {
	files?: number;
	additions?: number;
	deletions?: number;
};

export type ExecutionOutputFileChangeData = {
	files: ExecutionOutputFileChangeEntry[];
	patch?: string;
	patchRef?: string;
	snapshotRefs: string[];
	stats?: ExecutionOutputFileChangeSummary;
	sourceNodeKey?: string;
	durableInstanceId?: string;
};

type DerivedExecutionOutputAgentRunOptions = {
	executionId: string;
	parentExecutionId: string;
	startedAt?: string | Date | null;
	completedAt?: string | Date | null;
	executionStatus?: string | null;
};

/**
 * Check if output is a Dapr agent output structure
 */
export function isDaprAgentOutput(output: unknown): output is DaprAgentOutput {
	if (!output || typeof output !== "object") {
		return false;
	}

	const obj = output as Record<string, unknown>;

	// Check for common Dapr agent output fields
	return (
		"plan_text" in obj ||
		"tasks" in obj ||
		"usage" in obj ||
		"trace_id" in obj ||
		"trace_metadata" in obj
	);
}

/**
 * Parse Dapr agent output to extract structured data
 */
export function parseDaprAgentOutput(output: unknown): DaprAgentOutput | null {
	if (!isDaprAgentOutput(output)) {
		return null;
	}

	return output;
}

function getRecordValue(
	record: Record<string, unknown>,
	keys: string[],
): unknown | undefined {
	for (const key of keys) {
		if (key in record && record[key] !== undefined && record[key] !== null) {
			return record[key];
		}
	}
	return undefined;
}

function toOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function toOptionalInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	if (typeof value === "string") {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return undefined;
}

function toOptionalQueryStringParam(
	value: string | undefined,
	key: string,
): string | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const url =
			value.startsWith("http://") || value.startsWith("https://")
				? new URL(value)
				: new URL(value, "http://localhost");
		const param = url.searchParams.get(key);
		return toOptionalString(param);
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;
}

function normalizeExecutionChangeStatus(
	value: unknown,
): ExecutionOutputFileChangeStatus {
	if (typeof value === "string") {
		const normalized = value.trim().toUpperCase();
		if (
			normalized === "A" ||
			normalized === "M" ||
			normalized === "D" ||
			normalized === "R"
		) {
			return normalized;
		}
		const operation = value.trim().toLowerCase();
		if (
			operation === "add" ||
			operation === "added" ||
			operation === "create" ||
			operation === "created" ||
			operation === "new"
		) {
			return "A";
		}
		if (
			operation === "delete" ||
			operation === "deleted" ||
			operation === "remove" ||
			operation === "removed"
		) {
			return "D";
		}
		if (operation === "rename" || operation === "renamed") {
			return "R";
		}
	}
	return "M";
}

function mergeFileChangeEntries(
	target: Map<string, ExecutionOutputFileChangeEntry>,
	entries: ExecutionOutputFileChangeEntry[],
) {
	for (const entry of entries) {
		const path = entry.path.trim();
		if (!path) {
			continue;
		}
		const existing = target.get(path);
		if (!existing) {
			target.set(path, { ...entry, path });
			continue;
		}
		target.set(path, {
			path,
			status:
				existing.status === "M" && entry.status !== "M"
					? entry.status
					: existing.status,
			oldPath: existing.oldPath ?? entry.oldPath,
		});
	}
}

function extractEntriesFromList(
	value: unknown,
): ExecutionOutputFileChangeEntry[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((item) => {
			if (typeof item === "string") {
				const path = item.trim();
				return path ? { path, status: "M" as const } : null;
			}
			const record = asRecord(item);
			if (!record) {
				return null;
			}
			const path = toOptionalString(record.path);
			if (!path) {
				return null;
			}
			return {
				path,
				status: normalizeExecutionChangeStatus(
					record.status ?? record.operation ?? record.op,
				),
				oldPath: toOptionalString(record.oldPath ?? record.old_path),
			};
		})
		.filter((entry): entry is ExecutionOutputFileChangeEntry => entry !== null);
}

function inferChangeStatusFromText(
	value: string,
): ExecutionOutputFileChangeStatus {
	const normalized = value.trim().toLowerCase();
	if (
		normalized.includes("new file") ||
		normalized.includes("created") ||
		normalized.includes("added")
	) {
		return "A";
	}
	if (normalized.includes("deleted") || normalized.includes("removed")) {
		return "D";
	}
	if (normalized.includes("renamed")) {
		return "R";
	}
	return "M";
}

function parseChangedFilesFromText(
	value: string,
): ExecutionOutputFileChangeEntry[] {
	const lines = value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) {
		return [];
	}

	const results: ExecutionOutputFileChangeEntry[] = [];
	let collectingList = false;

	const collectInlineEntries = (text: string) => {
		const matches = Array.from(text.matchAll(/`([^`]+)`([^`]*)/g));
		for (const match of matches) {
			const path = match[1]?.trim();
			if (!path) {
				continue;
			}
			results.push({
				path,
				status: inferChangeStatusFromText(match[2] ?? ""),
			});
		}
	};

	for (const line of lines) {
		const changedFilesMatch = line.match(
			/^\*{0,2}changed files:\*{0,2}\s*(.+)?$/i,
		);
		if (changedFilesMatch) {
			collectingList = true;
			const remainder = changedFilesMatch[1]?.trim();
			if (remainder) {
				collectInlineEntries(remainder);
			}
			continue;
		}

		if (collectingList) {
			if (/^[-*]\s+/.test(line) || /^`[^`]+`/.test(line)) {
				collectInlineEntries(line);
				continue;
			}
			collectingList = false;
		}
	}

	return results;
}

function buildCandidateRecords(
	output: unknown,
): Array<{ nodeKey?: string; record: Record<string, unknown> }> {
	const root = asRecord(output);
	if (!root) {
		return [];
	}

	const candidates: Array<{
		nodeKey?: string;
		record: Record<string, unknown>;
	}> = [];
	const pushRecord = (record: Record<string, unknown>, nodeKey?: string) => {
		candidates.push({ nodeKey, record });
		const nestedData = asRecord(record.data);
		if (nestedData) {
			candidates.push({ nodeKey, record: nestedData });
			const nestedDataResult = asRecord(nestedData.result);
			if (nestedDataResult) {
				candidates.push({ nodeKey, record: nestedDataResult });
			}
		}
		const nestedResult = asRecord(record.result);
		if (nestedResult) {
			candidates.push({ nodeKey, record: nestedResult });
			const nestedResultData = asRecord(nestedResult.data);
			if (nestedResultData) {
				candidates.push({ nodeKey, record: nestedResultData });
			}
		}
	};

	pushRecord(root);

	const outputs = asRecord(root.outputs);
	if (outputs) {
		const preferred = asRecord(outputs.da_agent_system_demo);
		if (preferred) {
			pushRecord(preferred, "da_agent_system_demo");
		}
		for (const [key, value] of Object.entries(outputs)) {
			if (key === "da_agent_system_demo") {
				continue;
			}
			const record = asRecord(value);
			if (record) {
				pushRecord(record, key);
			}
		}
	}

	return candidates;
}

function buildOutputNodeRecords(
	output: unknown,
): Array<{ nodeKey: string; record: Record<string, unknown> }> {
	const root = asRecord(output);
	const outputs = root ? asRecord(root.outputs) : null;
	if (!outputs) {
		return [];
	}

	const records: Array<{ nodeKey: string; record: Record<string, unknown> }> =
		[];
	for (const [nodeKey, value] of Object.entries(outputs)) {
		const outputRecord = asRecord(value);
		if (!outputRecord) {
			continue;
		}
		const dataRecord = asRecord(outputRecord.data) ?? outputRecord;
		records.push({ nodeKey, record: dataRecord });
	}
	return records;
}

function looksLikeDerivedAgentRunRecord(
	record: Record<string, unknown>,
): boolean {
	for (const key of [
		"agentWorkflowId",
		"daprInstanceId",
		"traceId",
		"agentProgress",
		"changeSummary",
		"fileChanges",
		"patch",
		"sandboxName",
		"engineMetadata",
		"sessionPersistence",
		"verification",
		"mode",
	]) {
		if (record[key] != null) {
			return true;
		}
	}
	return false;
}

function fallbackDerivedRunStatus(
	executionStatus: string | null | undefined,
): string {
	const normalized = executionStatus?.trim().toLowerCase();
	if (normalized === "success" || normalized === "completed") {
		return "completed";
	}
	if (normalized === "error" || normalized === "failed") {
		return "failed";
	}
	return "running";
}

function readTraceIdFromRecord(
	record: Record<string, unknown>,
): string | undefined {
	const direct = toOptionalString(record.traceId);
	if (direct) {
		return direct;
	}
	const progress = asRecord(record.agentProgress);
	return progress ? toOptionalString(progress.traceId) : undefined;
}

export function parseExecutionFileChangeData(
	output: unknown,
): ExecutionOutputFileChangeData | null {
	const candidates = buildCandidateRecords(output);
	if (candidates.length === 0) {
		return null;
	}

	const files = new Map<string, ExecutionOutputFileChangeEntry>();
	const snapshotRefs = new Set<string>();
	let patch: string | undefined;
	let patchRef: string | undefined;
	let stats: ExecutionOutputFileChangeSummary | undefined;
	let sourceNodeKey: string | undefined;
	let durableInstanceId: string | undefined;

	for (const candidate of candidates) {
		const { record } = candidate;

		const summary = asRecord(record.changeSummary);
		if (summary) {
			const summaryEntries = extractEntriesFromList(summary.files);
			if (summaryEntries.length > 0) {
				mergeFileChangeEntries(files, summaryEntries);
				sourceNodeKey ??= candidate.nodeKey;
			}
			const summaryStats = asRecord(summary.stats);
			if (summaryStats && !stats) {
				stats = {
					files: toOptionalInt(summaryStats.files),
					additions: toOptionalInt(summaryStats.additions),
					deletions: toOptionalInt(summaryStats.deletions),
				};
			}
		}

		const fileChanges = extractEntriesFromList(record.fileChanges);
		if (fileChanges.length > 0) {
			mergeFileChangeEntries(files, fileChanges);
			sourceNodeKey ??= candidate.nodeKey;
		}

		for (const entry of extractEntriesFromList(record.snapshotRefs)) {
			snapshotRefs.add(entry.path);
			mergeFileChangeEntries(files, [entry]);
			sourceNodeKey ??= candidate.nodeKey;
		}

		const nextPatch = toOptionalString(record.patch);
		if (!patch && nextPatch) {
			patch = nextPatch;
			sourceNodeKey ??= candidate.nodeKey;
		}

		const nextPatchRef = toOptionalString(record.patchRef ?? record.patch_ref);
		if (!patchRef && nextPatchRef) {
			patchRef = nextPatchRef;
			sourceNodeKey ??= candidate.nodeKey;
		}

		const nextDurableInstanceId =
			toOptionalString(
				record.durableInstanceId ??
					record.durable_instance_id ??
					record.daprInstanceId ??
					record.dapr_instance_id,
			) ?? toOptionalQueryStringParam(nextPatchRef, "durableInstanceId");
		if (!durableInstanceId && nextDurableInstanceId) {
			durableInstanceId = nextDurableInstanceId;
			sourceNodeKey ??= candidate.nodeKey;
		}

		for (const textValue of [
			toOptionalString(record.text),
			toOptionalString(record.content),
			toOptionalString(record.stdout),
			toOptionalString(record.summary),
		]) {
			if (!textValue) {
				continue;
			}
			const parsedTextEntries = parseChangedFilesFromText(textValue);
			if (parsedTextEntries.length === 0) {
				continue;
			}
			mergeFileChangeEntries(files, parsedTextEntries);
			if (!stats) {
				stats = {
					files: parsedTextEntries.length,
				};
			}
			sourceNodeKey ??= candidate.nodeKey;
			break;
		}
	}

	const parsedFiles = Array.from(files.values()).sort((a, b) =>
		a.path.localeCompare(b.path),
	);
	const parsedSnapshotRefs = Array.from(snapshotRefs).sort((a, b) =>
		a.localeCompare(b),
	);

	if (
		parsedFiles.length === 0 &&
		parsedSnapshotRefs.length === 0 &&
		!patch &&
		!patchRef &&
		!stats
	) {
		return null;
	}

	return {
		files: parsedFiles,
		patch,
		patchRef,
		snapshotRefs: parsedSnapshotRefs,
		stats,
		sourceNodeKey,
		durableInstanceId,
	};
}

export function extractExecutionTraceIds(output: unknown): string[] {
	const ids = new Set<string>();
	for (const candidate of buildCandidateRecords(output)) {
		const traceId = readTraceIdFromRecord(candidate.record);
		if (traceId) {
			ids.add(traceId);
		}
	}
	return Array.from(ids);
}

export function deriveAgentRunsFromExecutionOutput(
	output: unknown,
	options: DerivedExecutionOutputAgentRunOptions,
): DurableAgentRunSummary[] {
	const createdAt =
		parseTimestamp(options.startedAt) || new Date(0).toISOString();
	const completedAt = parseTimestamp(options.completedAt);
	const runs: DurableAgentRunSummary[] = [];

	for (const { nodeKey, record } of buildOutputNodeRecords(output)) {
		if (!looksLikeDerivedAgentRunRecord(record)) {
			continue;
		}
		const status =
			toOptionalString(record.status) ??
			fallbackDerivedRunStatus(options.executionStatus);
		const agentWorkflowId =
			toOptionalString(record.agentWorkflowId ?? record.daprInstanceId) ??
			`derived:${options.executionId}:${nodeKey}`;
		const daprInstanceId =
			toOptionalString(record.daprInstanceId ?? record.agentWorkflowId) ??
			agentWorkflowId;
		runs.push({
			id: `derived:${options.executionId}:${nodeKey}`,
			nodeId: nodeKey,
			mode: toOptionalString(record.mode) ?? "execute_direct",
			status,
			agentWorkflowId,
			daprInstanceId,
			parentExecutionId: options.parentExecutionId,
			workspaceRef:
				toOptionalString(record.workspaceRef ?? record.workspace_ref) ?? null,
			artifactRef: toOptionalString(record.artifactRef) ?? null,
			createdAt,
			completedAt: status === "running" ? null : completedAt || createdAt,
			eventPublishedAt: null,
			lastReconciledAt:
				status === "running" ? createdAt : completedAt || createdAt,
			error: toOptionalString(record.error) ?? null,
			result: record,
		});
	}

	return runs;
}

export function parseExecutionOutcomeSummary(
	output: unknown,
): ExecutionOutcomeSummary | null {
	if (!output || typeof output !== "object") {
		return null;
	}

	const root = output as Record<string, unknown>;
	const nestedResult =
		root.result && typeof root.result === "object"
			? (root.result as Record<string, unknown>)
			: null;

	const records: Array<Record<string, unknown>> = [root];
	if (nestedResult) {
		records.push(nestedResult);
	}

	const read = (keys: string[]) => {
		for (const record of records) {
			const value = getRecordValue(record, keys);
			if (value !== undefined) {
				return value;
			}
		}
		return undefined;
	};

	const branch = toOptionalString(read(["branch"]));
	const commit = toOptionalString(read(["commit"]));
	const prUrl = toOptionalString(read(["prUrl", "pr_url"]));
	const prState = toOptionalString(read(["prState", "pr_state"]));
	const remote = toOptionalString(read(["remote"]));

	const prNumberRaw = read(["prNumber", "pr_number"]);
	const prNumber =
		typeof prNumberRaw === "number" || typeof prNumberRaw === "string"
			? prNumberRaw
			: undefined;

	const changedFileCount = toOptionalInt(
		read(["changedFileCount", "changed_count"]),
	);

	const summary: ExecutionOutcomeSummary = {
		branch,
		commit,
		prNumber,
		prUrl,
		prState,
		remote,
		changedFileCount,
	};

	const hasData = Object.values(summary).some((value) => value !== undefined);
	return hasData ? summary : null;
}

// ============================================================================
// Token Count Formatting
// ============================================================================

/**
 * Format token count with K/M suffix for large numbers
 * Examples: 1234 -> "1,234", 12345 -> "12.3K", 1234567 -> "1.2M"
 */
export function formatTokenCount(count: number): string {
	if (count < 1000) {
		return count.toLocaleString();
	}
	if (count < 1_000_000) {
		return `${(count / 1000).toFixed(1)}K`;
	}
	return `${(count / 1_000_000).toFixed(1)}M`;
}

// ============================================================================
// Time Formatting
// ============================================================================

/**
 * Format timestamp as relative time for recent entries, absolute for older ones.
 * - < 1 min: "Just now"
 * - < 60 mins: "X mins ago"
 * - < 24 hours: "X hours ago"
 * - Yesterday: "Yesterday at 2:30 PM"
 * - This week: "Monday at 2:30 PM"
 * - Older: "Jan 23, 2026"
 */
export function formatRelativeTime(timestamp: string | Date): string {
	if (!timestamp) {
		return "-";
	}

	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return "-";
	}

	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60_000);
	const diffHours = Math.floor(diffMs / 3_600_000);
	const diffDays = Math.floor(diffMs / 86_400_000);

	// Format time for use in combined strings
	const timeStr = date.toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});

	// Less than 1 minute
	if (diffMins < 1) {
		return "Just now";
	}

	// Less than 60 minutes
	if (diffMins < 60) {
		return diffMins === 1 ? "1 min ago" : `${diffMins} mins ago`;
	}

	// Less than 24 hours
	if (diffHours < 24) {
		return diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
	}

	// Yesterday
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	const yesterdayStr = yesterday.toLocaleDateString("en-US");
	const eventDateStr = date.toLocaleDateString("en-US");
	if (eventDateStr === yesterdayStr) {
		return `Yesterday at ${timeStr}`;
	}

	// Within the past week (show day name)
	if (diffDays < 7) {
		const dayName = date.toLocaleDateString("en-US", {
			weekday: "long",
		});
		return `${dayName} at ${timeStr}`;
	}

	// Older than a week - show date
	return date.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

/**
 * Format timestamp for display (includes date)
 * Uses relative time for recent entries, absolute for older ones
 */
export function formatTimestamp(timestamp: string | Date): string {
	return formatRelativeTime(timestamp);
}

/**
 * Format timestamp as absolute date/time (for tooltips)
 * Format: "23 Jan 2026 1:06:20 PM"
 */
export function formatAbsoluteTimestamp(timestamp: string | Date): string {
	if (!timestamp) {
		return "-";
	}

	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return "-";
	}

	const options: Intl.DateTimeFormatOptions = {
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
		hour12: true,
	};

	return date.toLocaleString("en-US", options);
}

/**
 * Format time only (for compact display)
 * Format: "1:07:42 PM"
 */
export function formatTimeOnly(timestamp: string | Date): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return "-";
	}

	return date.toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
		hour12: true,
	});
}

/**
 * Format full date and time for detail header
 * Format: "01:06:20 PM - 23 Jan 2026"
 */
export function formatDateTime(timestamp: string | Date): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return "-";
	}

	const time = date.toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: true,
	});

	const dateStr = date.toLocaleDateString("en-US", {
		day: "numeric",
		month: "short",
		year: "numeric",
	});

	return `${time} - ${dateStr}`;
}

// ============================================================================
// Execution Events Transformation
// ============================================================================

/**
 * Transform execution logs to Dapr execution events
 */
export function mapExecutionLogsToEvents(
	logs: WorkflowExecutionLog[],
	workflowStart: string | Date,
	workflowEnd?: string | Date | null,
	workflowStatus?: string,
	workflowInput?: unknown,
): DaprExecutionEvent[] {
	const events: DaprExecutionEvent[] = [];
	let eventId = 1;

	// Add OrchestratorStarted event with workflow input
	events.push({
		eventId: null,
		eventType: "OrchestratorStarted",
		name: null,
		timestamp: parseTimestamp(workflowStart),
		input: workflowInput,
		metadata: {},
	});

	// Process execution logs
	for (const log of logs) {
		const eventType = mapExecutionLogEvent(log.status);

		events.push({
			eventId: eventType === "TaskScheduled" ? null : eventId++,
			eventType,
			name: log.nodeId || null,
			timestamp: parseTimestamp(log.timestamp),
			input: log.input,
			output: log.output,
			metadata: {
				status: log.status,
				taskId: log.nodeId,
			},
		});
	}

	// Add ExecutionCompleted event if workflow is complete
	if (
		workflowEnd &&
		(workflowStatus === "success" ||
			workflowStatus === "error" ||
			workflowStatus === "cancelled")
	) {
		events.push({
			eventId,
			eventType: "ExecutionCompleted",
			name: null,
			timestamp: parseTimestamp(workflowEnd),
			metadata: {
				executionDuration:
					calculateDuration(workflowStart, workflowEnd) || undefined,
				status: mapWorkflowStatus(workflowStatus),
			},
		});
	}

	// Sort by timestamp descending (most recent first)
	return events.sort(
		(a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
	);
}

// ============================================================================
// Workflow Transformations
// ============================================================================

/** Default app ID for the workflow orchestrator */
const DEFAULT_APP_ID = "workflow-builder";

/**
 * Transform WorkflowExecution to WorkflowListItem
 */
export function toWorkflowListItem(
	execution: WorkflowExecution,
	workflow: Workflow,
): WorkflowListItem {
	const startTime = parseTimestamp(execution.startedAt);
	const endTime = execution.completedAt
		? parseTimestamp(execution.completedAt)
		: null;
	const daprWorkflowVersion =
		(
			execution as WorkflowExecution & {
				daprWorkflowVersion?: string | null;
			}
		).daprWorkflowVersion ?? null;

	return {
		executionId: execution.id,
		instanceId: execution.id,
		daprInstanceId: execution.daprInstanceId,
		workflowType: workflow.daprWorkflowName || "dynamic-workflow",
		appId: DEFAULT_APP_ID,
		status: mapWorkflowStatus(execution.status),
		startTime,
		endTime,
		workflowName: workflow.name,
		workflowVersion: daprWorkflowVersion,
		workflowNameVersioned: daprWorkflowVersion
			? `${workflow.daprWorkflowName || "dynamic-workflow"}@${daprWorkflowVersion}`
			: null,
		customStatus: execution.phase
			? {
					phase: execution.phase as any,
					progress: execution.progress ?? 0,
					message: "",
				}
			: undefined,
	};
}

/**
 * Transform WorkflowExecution to WorkflowDetail
 */
export function toWorkflowDetail(
	execution: WorkflowExecution,
	workflow: Workflow,
	logs: WorkflowExecutionLog[],
): WorkflowDetail {
	const listItem = toWorkflowListItem(execution, workflow);

	// Build execution history
	const executionHistory = mapExecutionLogsToEvents(
		logs,
		execution.startedAt,
		execution.completedAt,
		execution.status,
		execution.input,
	);

	return {
		...listItem,
		executionDuration: calculateDuration(
			execution.startedAt,
			execution.completedAt,
		),
		input: execution.input || {},
		output: execution.output || {},
		executionHistory,
	};
}

// ============================================================================
// Filtering
// ============================================================================

/**
 * Filter workflow list items by search query
 */
export function filterWorkflowsBySearch(
	workflows: WorkflowListItem[],
	search?: string,
): WorkflowListItem[] {
	if (!search?.trim()) {
		return workflows;
	}

	const query = search.toLowerCase().trim();
	return workflows.filter(
		(w) =>
			w.instanceId.toLowerCase().includes(query) ||
			w.workflowType.toLowerCase().includes(query) ||
			w.workflowName?.toLowerCase().includes(query) ||
			w.appId.toLowerCase().includes(query),
	);
}

/**
 * Filter workflow list items by status
 */
export function filterWorkflowsByStatus(
	workflows: WorkflowListItem[],
	statuses?: WorkflowUIStatus[],
): WorkflowListItem[] {
	if (!statuses?.length) {
		return workflows;
	}
	return workflows.filter((w) => statuses.includes(w.status));
}

/**
 * Filter workflow list items by app ID
 */
export function filterWorkflowsByAppId(
	workflows: WorkflowListItem[],
	appId?: string,
): WorkflowListItem[] {
	if (!appId?.trim()) {
		return workflows;
	}
	return workflows.filter((w) => w.appId === appId);
}

/**
 * Apply all filters to workflow list
 */
export function applyWorkflowFilters(
	workflows: WorkflowListItem[],
	filters: {
		search?: string;
		status?: WorkflowUIStatus[];
		appId?: string;
	},
): WorkflowListItem[] {
	let filtered = workflows;
	filtered = filterWorkflowsBySearch(filtered, filters.search);
	filtered = filterWorkflowsByStatus(filtered, filters.status);
	filtered = filterWorkflowsByAppId(filtered, filters.appId);
	return filtered;
}
