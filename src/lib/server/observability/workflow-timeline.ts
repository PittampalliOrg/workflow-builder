import type {
	ObservabilityTraceSpan,
	ObservabilityWorkflowStep,
	ObservabilityWorkflowCorrelationSource,
	ObservabilityWorkflowTimelineItem,
	ObservabilityWorkflowTimelineKind
} from '$lib/types/observability';

type TimelineStatus = ObservabilityWorkflowTimelineItem['status'];

interface TimelineDraft {
	id: string;
	sequence: number | null;
	workflowSequence: number | null;
	fallbackOrder: number | null;
	kind: ObservabilityWorkflowTimelineKind;
	title: string;
	subtitle: string | null;
	status: TimelineStatus;
	startedAt: string | null;
	completedAt: string | null;
	durationMs: number | null;
	nodeId: string | null;
	nodeName: string | null;
	actionType: string | null;
	traceId: string | null;
	spanId: string | null;
	relatedSpanIds: string[];
	correlationId: string | null;
	daprTaskIds: string[];
	correlationSources: ObservabilityWorkflowCorrelationSource[];
	durableTaskId: string | null;
	durableTaskName: string | null;
	serviceName: string | null;
	inputSpanId: string | null;
	outputSpanId: string | null;
	hasInput: boolean;
	hasOutput: boolean;
}

const SYSTEM_ACTIVITY_NAMES = new Set([
	'emit_mlflow_node_span',
	'finalize_mlflow_trace_root',
	'persist_results_to_db',
	'persist_workspace_session',
	'track_agent_run_scheduled',
	'track_agent_run_running',
	'track_agent_run_completed'
]);

function attr(span: ObservabilityTraceSpan, key: string): string | null {
	const value = span.attributes?.[key];
	if (value == null) return null;
	const text = String(value).trim();
	return text || null;
}

function numeric(value: unknown): number | null {
	if (value == null || value === '') return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function attrNumber(span: ObservabilityTraceSpan, key: string): number | null {
	return numeric(span.attributes?.[key]);
}

function timeMs(value: string | null): number | null {
	if (!value) return null;
	const parsed = new Date(value).getTime();
	return Number.isFinite(parsed) ? parsed : null;
}

function endTime(span: ObservabilityTraceSpan): string | null {
	const start = timeMs(span.startTime);
	if (start == null) return null;
	return new Date(start + span.duration).toISOString();
}

function statusRank(status: TimelineStatus): number {
	if (status === 'error') return 4;
	if (status === 'running') return 3;
	if (status === 'pending') return 2;
	if (status === 'success') return 1;
	return 0;
}

function mergeStatus(a: TimelineStatus, b: TimelineStatus): TimelineStatus {
	return statusRank(b) > statusRank(a) ? b : a;
}

function statusFromSpan(span: ObservabilityTraceSpan): TimelineStatus {
	return span.status === 'error' ? 'error' : 'success';
}

function normalizeActivityName(value: string | null): string | null {
	if (!value) return null;
	return value
		.replace(/^activity[:|.]+/i, '')
		.replace(/^activity\|\|/i, '')
		.replace(/^workflow\.node\./i, '')
		.trim()
		.toLowerCase();
}

function nativeActivityName(span: ObservabilityTraceSpan): string | null {
	const durableName = attr(span, 'durabletask.task.name');
	if (durableName) return durableName;
	const match = span.operationName.match(/^activity\|\|(.+)$/);
	return match?.[1] ?? null;
}

function nodeIdForSpan(span: ObservabilityTraceSpan): string | null {
	return attr(span, 'workflow.node.id') ?? attr(span, 'node.id');
}

function nodeNameForSpan(span: ObservabilityTraceSpan): string | null {
	return attr(span, 'workflow.node.name') ?? attr(span, 'node.name') ?? nodeIdForSpan(span);
}

function actionTypeForSpan(span: ObservabilityTraceSpan): string | null {
	return (
		attr(span, 'workflow.node.action_type') ??
		attr(span, 'node.action_type') ??
		attr(span, 'action.type') ??
		null
	);
}

function correlationIdForSpan(span: ObservabilityTraceSpan): string | null {
	return attr(span, 'workflow.activity.correlation_id');
}

function classifyNativeSpan(span: ObservabilityTraceSpan): ObservabilityWorkflowTimelineKind {
	const op = span.operationName.toLowerCase();
	const name = normalizeActivityName(nativeActivityName(span));
	if (op.includes('orchestration')) return 'child_workflow';
	if (name && SYSTEM_ACTIVITY_NAMES.has(name)) return 'system';
	return 'dapr_activity';
}

function hasInput(span: ObservabilityTraceSpan): boolean {
	return span.hasInput ?? span.attributes?.['input.value'] != null;
}

function hasOutput(span: ObservabilityTraceSpan): boolean {
	return span.hasOutput ?? span.attributes?.['output.value'] != null;
}

function ioLength(span: ObservabilityTraceSpan, key: 'input.value' | 'output.value'): number {
	const compactSize = key === 'input.value' ? span.inputSize : span.outputSize;
	if (compactSize != null) return compactSize;
	const value = span.attributes?.[key];
	if (value == null) return 0;
	return typeof value === 'string' ? value.length : JSON.stringify(value).length;
}

function maybeSelectIoSpan(
	draft: TimelineDraft,
	span: ObservabilityTraceSpan,
	spanById: Map<string, ObservabilityTraceSpan>,
	key: 'input.value' | 'output.value'
): string | null {
	const currentId = key === 'input.value' ? draft.inputSpanId : draft.outputSpanId;
	const current = currentId ? spanById.get(currentId) : null;
	const currentLength = current ? ioLength(current, key) : -1;
	const nextLength = ioLength(span, key);
	return nextLength >= currentLength ? span.spanId : currentId;
}

function newDraft(params: {
	id: string;
	kind: ObservabilityWorkflowTimelineKind;
	title: string;
	subtitle?: string | null;
	sequence?: number | null;
	fallbackOrder?: number | null;
	nodeId?: string | null;
	nodeName?: string | null;
	actionType?: string | null;
	status?: TimelineStatus;
}): TimelineDraft {
	return {
		id: params.id,
		sequence: params.sequence ?? null,
		workflowSequence: params.kind === 'workflow_node' ? (params.sequence ?? null) : null,
		fallbackOrder: params.fallbackOrder ?? null,
		kind: params.kind,
		title: params.title,
		subtitle: params.subtitle ?? null,
		status: params.status ?? 'unknown',
		startedAt: null,
		completedAt: null,
		durationMs: null,
		nodeId: params.nodeId ?? null,
		nodeName: params.nodeName ?? null,
		actionType: params.actionType ?? null,
		traceId: null,
		spanId: null,
		relatedSpanIds: [],
		correlationId: null,
		daprTaskIds: [],
		correlationSources: [],
		durableTaskId: null,
		durableTaskName: null,
		serviceName: null,
		inputSpanId: null,
		outputSpanId: null,
		hasInput: false,
		hasOutput: false
	};
}

function mergeTimes(draft: TimelineDraft, startedAt: string | null, completedAt: string | null): void {
	const currentStart = timeMs(draft.startedAt);
	const nextStart = timeMs(startedAt);
	if (nextStart != null && (currentStart == null || nextStart < currentStart)) {
		draft.startedAt = startedAt;
	}

	const currentEnd = timeMs(draft.completedAt);
	const nextEnd = timeMs(completedAt);
	if (nextEnd != null && (currentEnd == null || nextEnd > currentEnd)) {
		draft.completedAt = completedAt;
	}

	const start = timeMs(draft.startedAt);
	const end = timeMs(draft.completedAt);
	if (start != null && end != null && end >= start) {
		draft.durationMs = end - start;
	}
}

function mergeSpan(
	draft: TimelineDraft,
	span: ObservabilityTraceSpan,
	spanById: Map<string, ObservabilityTraceSpan>,
	source?: ObservabilityWorkflowCorrelationSource
): void {
	if (!draft.relatedSpanIds.includes(span.spanId)) draft.relatedSpanIds.push(span.spanId);
	if (source && !draft.correlationSources.includes(source)) draft.correlationSources.push(source);
	if (!draft.traceId) draft.traceId = span.traceId;
	if (!draft.spanId) draft.spanId = span.spanId;
	if (!draft.serviceName) draft.serviceName = span.serviceName;
	draft.status = mergeStatus(draft.status, statusFromSpan(span));
	mergeTimes(draft, span.startTime, endTime(span));

	const correlationId = correlationIdForSpan(span);
	if (correlationId && !draft.correlationId) draft.correlationId = correlationId;
	const durableTaskId = attr(span, 'durabletask.task.task_id');
	if (durableTaskId) {
		if (!draft.daprTaskIds.includes(durableTaskId)) draft.daprTaskIds.push(durableTaskId);
		if (!draft.durableTaskId) draft.durableTaskId = durableTaskId;
		if (!draft.correlationSources.includes('dapr_task')) draft.correlationSources.push('dapr_task');
	}
	const durableTaskName = attr(span, 'durabletask.task.name') ?? nativeActivityName(span);
	if (durableTaskName && !draft.durableTaskName) draft.durableTaskName = durableTaskName;
	if (draft.sequence == null) {
		draft.sequence = draft.workflowSequence ?? numeric(durableTaskId);
	}
	if (!draft.nodeId) draft.nodeId = nodeIdForSpan(span);
	if (!draft.nodeName) draft.nodeName = nodeNameForSpan(span);
	if (!draft.actionType) draft.actionType = actionTypeForSpan(span);
	if (hasInput(span)) {
		const selected = maybeSelectIoSpan(draft, span, spanById, 'input.value');
		if (selected) draft.inputSpanId = selected;
		draft.hasInput = true;
	}
	if (hasOutput(span)) {
		const selected = maybeSelectIoSpan(draft, span, spanById, 'output.value');
		if (selected) draft.outputSpanId = selected;
		draft.hasOutput = true;
	}
}

function mergeStep(draft: TimelineDraft, step: ObservabilityWorkflowStep): void {
	if (!draft.correlationSources.includes('workflow_logs')) draft.correlationSources.push('workflow_logs');
	draft.nodeId ??= step.stepName;
	draft.nodeName ??= step.label;
	draft.actionType ??= step.actionType || null;
	draft.title = step.label || draft.title;
	draft.subtitle ??= step.actionType || step.stepName;
	draft.status = mergeStatus(draft.status, step.status);
	if (step.durationMs != null && draft.durationMs == null) draft.durationMs = step.durationMs;
	mergeTimes(draft, step.startedAt, step.completedAt);
}

function overlaps(a: ObservabilityTraceSpan, b: ObservabilityTraceSpan): boolean {
	const aStart = timeMs(a.startTime);
	const bStart = timeMs(b.startTime);
	if (aStart == null || bStart == null) return false;
	const aEnd = aStart + a.duration;
	const bEnd = bStart + b.duration;
	return aStart <= bEnd + 500 && bStart <= aEnd + 500;
}

function findNativeTarget(
	native: ObservabilityTraceSpan,
	drafts: TimelineDraft[],
	spanById: Map<string, ObservabilityTraceSpan>
): { draft: TimelineDraft; source: ObservabilityWorkflowCorrelationSource } | null {
	const correlationId = correlationIdForSpan(native);
	if (correlationId) {
		const matches = drafts.filter((draft) => draft.correlationId === correlationId);
		if (matches.length === 1) return { draft: matches[0], source: 'dapr_task' };
	}
	const nativeName = normalizeActivityName(nativeActivityName(native));
	if (!nativeName) return null;
	const matches = drafts.filter((draft) => {
		if (draft.traceId && draft.traceId !== native.traceId) return false;
		return draft.relatedSpanIds.some((spanId) => {
			const span = spanById.get(spanId);
			if (!span || !overlaps(native, span)) return false;
			return normalizeActivityName(span.operationName)?.includes(nativeName) === true;
		});
	});
	return matches.length === 1 ? { draft: matches[0], source: 'time_overlap' } : null;
}

function finalSortValue(item: TimelineDraft): number {
	if (item.workflowSequence != null) return item.workflowSequence * 1_000;
	if (item.sequence != null) return item.sequence * 1_000;
	if (item.fallbackOrder != null) return item.fallbackOrder * 1_000;
	return timeMs(item.startedAt) ?? Number.MAX_SAFE_INTEGER;
}

export function buildWorkflowTimeline(args: {
	traceSpans: ObservabilityTraceSpan[];
	workflowSteps: ObservabilityWorkflowStep[];
}): ObservabilityWorkflowTimelineItem[] {
	const spanById = new Map(args.traceSpans.map((span) => [span.spanId, span]));
	const drafts = new Map<string, TimelineDraft>();

	const ensure = (key: string, params: Parameters<typeof newDraft>[0]): TimelineDraft => {
		const existing = drafts.get(key);
		if (existing) return existing;
		const draft = newDraft(params);
		drafts.set(key, draft);
		return draft;
	};

	for (const [index, step] of args.workflowSteps.entries()) {
		const key = `node:${step.stepName}:step`;
		const draft = ensure(key, {
			id: key,
			kind: 'workflow_node',
			title: step.label || step.stepName,
			subtitle: step.actionType || step.stepName,
			fallbackOrder: index,
			nodeId: step.stepName,
			nodeName: step.label,
			actionType: step.actionType,
			status: step.status
		});
		mergeStep(draft, step);
	}

	for (const span of args.traceSpans) {
		const nodeId = nodeIdForSpan(span);
		if (!nodeId) continue;
		const workflowSequence = attrNumber(span, 'workflow.node.sequence');
		const key = `node:${nodeId}:step`;
		const title = nodeNameForSpan(span) ?? nodeId;
		const draft = ensure(key, {
			id: key,
			kind: 'workflow_node',
			title,
			subtitle: actionTypeForSpan(span) ?? span.operationName,
			sequence: workflowSequence,
			nodeId,
			nodeName: title,
			actionType: actionTypeForSpan(span),
			status: statusFromSpan(span)
		});
		if (workflowSequence != null) {
			draft.workflowSequence = workflowSequence;
			draft.sequence = workflowSequence;
		}
		mergeSpan(draft, span, spanById, 'workflow_node');
	}

	for (const span of args.traceSpans) {
		const durableTaskId = attr(span, 'durabletask.task.task_id');
		const isNative =
			span.operationName.startsWith('activity||') ||
			span.operationName.includes('orchestration||') ||
			durableTaskId != null;
		if (!isNative) continue;

		const target = findNativeTarget(span, [...drafts.values()], spanById);
		if (target) {
			mergeSpan(target.draft, span, spanById, target.source);
			continue;
		}

		const durableTaskName = attr(span, 'durabletask.task.name') ?? nativeActivityName(span);
		const kind = classifyNativeSpan(span);
		const key = `dapr:${span.traceId}:${durableTaskId ?? span.spanId}`;
		const title =
			kind === 'child_workflow'
				? 'Dapr child workflow'
				: kind === 'system'
					? `Dapr system activity: ${durableTaskName ?? span.operationName}`
					: `Dapr activity: ${durableTaskName ?? span.operationName}`;
		const draft = ensure(key, {
			id: key,
			kind,
			title,
			subtitle: span.operationName,
			sequence: numeric(durableTaskId),
			status: statusFromSpan(span)
		});
		mergeSpan(draft, span, spanById, 'dapr_task');
	}

	for (const span of args.traceSpans) {
		if (span.operationName !== 'workflow.init') continue;
		const key = `system:${span.traceId}:${span.spanId}`;
		const draft = ensure(key, {
			id: key,
			kind: 'system',
			title: 'Workflow initialized',
			subtitle: attr(span, 'workflow.name') ?? attr(span, 'workflow.id') ?? null,
			status: statusFromSpan(span)
		});
		mergeSpan(draft, span, spanById);
	}

	return [...drafts.values()]
		.sort((a, b) => {
			const order = finalSortValue(a) - finalSortValue(b);
			if (order !== 0) return order;
			return (timeMs(a.startedAt) ?? 0) - (timeMs(b.startedAt) ?? 0);
		})
		.map((draft, index) => ({
			id: draft.id,
			kind: draft.kind,
			title: draft.title,
			subtitle: draft.subtitle,
			status: draft.status,
			startedAt: draft.startedAt,
			completedAt: draft.completedAt,
			durationMs: draft.durationMs,
			nodeId: draft.nodeId,
			nodeName: draft.nodeName,
			actionType: draft.actionType,
			traceId: draft.traceId,
			spanId: draft.spanId,
			relatedSpanIds: draft.relatedSpanIds,
			correlationId: draft.correlationId,
			daprTaskIds: draft.daprTaskIds,
			correlationSources: draft.correlationSources,
			durableTaskId: draft.durableTaskId,
			durableTaskName: draft.durableTaskName,
			serviceName: draft.serviceName,
			inputSpanId: draft.inputSpanId,
			outputSpanId: draft.outputSpanId,
			hasInput: draft.hasInput,
			hasOutput: draft.hasOutput,
			sequence: draft.sequence ?? index + 1
		}));
}
