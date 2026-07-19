import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import {
	boundDiagnosticEvidence,
	redactDiagnosticEvidence
} from '$lib/server/application/diagnostic-redaction';
import { guardAnalystAccess } from '../guard';

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function text(value: unknown, max = 2_000): string | null {
	if (typeof value !== 'string') return null;
	return String(boundDiagnosticEvidence(value, max).value);
}

function diagnosticUrl(value: unknown): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	try {
		const parsed = new URL(value);
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return null;
	}
}

/** Bounded first-pass execution state and persisted evidence inventory. */
export const GET: RequestHandler = async ({ params, request }) => {
	const guard = await guardAnalystAccess(request, params.executionId);
	if (!guard.ok) return guard.res;

	const app = getApplicationAdapters();
	const statusResult = await app.workflowExecutionControl.getExecutionStatus({
		executionId: guard.execution.id,
		userId: guard.execution.userId,
		projectId: guard.execution.projectId,
		includeAgentEvents: true
	});
	if (statusResult.status === 'error') {
		return json({ error: statusResult.message }, { status: statusResult.httpStatus });
	}

	const model = asRecord(statusResult.body);
	const steps = Array.isArray(model.steps) ? model.steps.map(asRecord) : [];
	const events = Array.isArray(model.agentEvents) ? model.agentEvents.map(asRecord) : [];
	const agentRuns = Array.isArray(model.agentRuns) ? model.agentRuns.map(asRecord) : [];
	const artifacts = Array.isArray(model.artifacts) ? model.artifacts.map(asRecord) : [];
	const browserArtifacts = Array.isArray(model.browserArtifacts)
		? model.browserArtifacts.map(asRecord)
		: [];

	const summaryOutput = boundDiagnosticEvidence(model.summaryOutput ?? null, 10_000);
	return json(redactDiagnosticEvidence({
		execution: {
			executionId: model.executionId ?? guard.execution.id,
			instanceId: model.instanceId ?? guard.execution.daprInstanceId ?? null,
			workflowId: model.workflowId ?? guard.execution.workflowId,
			status: model.status ?? guard.execution.status,
			runtimeStatus: model.runtimeStatus ?? null,
			phase: model.phase ?? guard.execution.phase ?? null,
			progress: model.progress ?? guard.execution.progress ?? null,
			currentNodeId: model.currentNodeId ?? guard.execution.currentNodeId ?? null,
			currentNodeName: model.currentNodeName ?? guard.execution.currentNodeName ?? null,
			error: text(model.error ?? guard.execution.error, 4_000),
			startedAt: model.startedAt ?? guard.execution.startedAt?.toISOString() ?? null,
			completedAt: model.completedAt ?? guard.execution.completedAt?.toISOString() ?? null,
			traceId: guard.execution.primaryTraceId ?? null,
			traceIds: guard.execution.primaryTraceId ? [guard.execution.primaryTraceId] : [],
			sessionId: model.sessionId ?? guard.execution.workflowSessionId ?? null,
			summaryOutput: summaryOutput.value,
			summaryOutputTruncated: summaryOutput.truncated
		},
		steps: steps.slice(-40).map((step) => ({
			logId: step.logId ?? null,
			stepName: step.stepName ?? null,
			label: step.displayLabel ?? step.label ?? null,
			actionType: step.actionType ?? null,
			status: step.status ?? null,
			durationMs: step.durationMs ?? null,
			startedAt: step.startedAt ?? null,
			completedAt: step.completedAt ?? null,
			error: text(step.error)
		})),
		recentEvents: events.slice(-40).map((event) => ({
			id: event.id ?? null,
			type: event.type ?? null,
			timestamp: event.timestamp ?? null,
			phase: event.phase ?? null,
			toolName: event.toolName ?? null,
			sessionId: event.workflowAgentRunId ?? event.daprInstanceId ?? null
		})),
		agentRuns: agentRuns.slice(-50).map((run) => ({
			id: run.id ?? null,
			nodeId: run.nodeId ?? null,
			status: run.status ?? null,
			mode: run.mode ?? null,
			daprInstanceId: run.daprInstanceId ?? null,
			workspaceRef: run.workspaceRef ?? null,
			error: text(run.error)
		})),
		artifacts: artifacts.slice(0, 100).map((artifact) => ({
			id: artifact.id ?? null,
			kind: artifact.kind ?? null,
			title: artifact.title ?? null,
			fileId: artifact.fileId ?? null,
			createdAt: artifact.createdAt ?? null
		})),
		browserArtifacts: browserArtifacts.slice(0, 100).map((artifact) => ({
			id: artifact.id ?? null,
			nodeId: artifact.nodeId ?? null,
			status: artifact.status ?? null,
			createdAt: artifact.createdAt ?? null,
			assets: (Array.isArray(asRecord(artifact.manifestJson).assets)
				? (asRecord(artifact.manifestJson).assets as unknown[]).map(asRecord)
				: []
			).slice(0, 100).map((asset) => ({
				kind: asset.kind ?? null,
				label: asset.label ?? null,
				storageRef: asset.storageRef ?? null,
				contentType: asset.contentType ?? null,
				fileName: asset.fileName ?? null,
				stepId: asset.stepId ?? null
			})),
			steps: (Array.isArray(asRecord(artifact.manifestJson).steps)
				? (asRecord(artifact.manifestJson).steps as unknown[]).map(asRecord)
				: []
			).slice(0, 100).map((step) => ({
				id: step.id ?? null,
				label: step.label ?? null,
				status: step.status ?? null,
				url: diagnosticUrl(step.url),
				screenshotStorageRef: step.screenshotStorageRef ?? null
			}))
		})),
		truncated: {
			steps: steps.length > 40,
			recentEvents: events.length > 40,
			agentRuns: agentRuns.length > 50,
			artifacts: artifacts.length > 100,
			browserArtifacts: browserArtifacts.length > 100
		},
		observedAt: new Date().toISOString()
	}));
};
