import { env } from '$env/dynamic/private';
import { isHttpError, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { validatePreviewControlIdentity } from '$lib/server/application/preview-control-identity';
import { PreviewControlSourceAuthorityError } from '$lib/server/application/preview-control-source-authority';
import {
	PreviewWorkflowDiagnosticsError,
	type PreviewWorkflowDiagnosticsBrokerCommand
} from '$lib/server/application/preview-workflow-diagnostics';
import type {
	PreviewControlIdentity,
	PreviewWorkflowDiagnosticsOperation,
	WorkflowDiagnosticsExecution
} from '$lib/server/application/ports';
import { redactDiagnosticEvidence } from '$lib/server/application/diagnostic-redaction';
import { requirePreviewControlCapability } from '$lib/server/internal-auth';
import {
	BoundedJsonBodyError,
	readBoundedJsonObject
} from '../../../_shared/bounded-json-body';

const MAX_REQUEST_BYTES = 64 * 1024;
const BODY_KEYS = ['identity', 'authorization', 'operation', 'execution', 'request'] as const;
const IDENTITY_KEYS = [
	'previewName',
	'environmentRequestId',
	'environmentPlatformRevision',
	'environmentSourceRevision',
	'catalogDigest'
] as const;
const EXECUTION_KEYS = [
	'id',
	'userId',
	'projectId',
	'status',
	'startedAt',
	'completedAt',
	'primaryTraceId',
	'workflowSessionId'
] as const;
const OPERATIONS = new Set<PreviewWorkflowDiagnosticsOperation>([
	'digest-telemetry',
	'resolve-trace-ids',
	'search-spans',
	'get-span',
	'search-llm-spans',
	'search-logs'
]);
const STATUSES = new Set(['pending', 'running', 'success', 'error', 'cancelled']);

function object(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', `${name} is invalid`);
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	input: Record<string, unknown>,
	keys: readonly string[],
	name: string
): void {
	if (
		Object.keys(input).length !== keys.length ||
		Object.keys(input).some((key) => !keys.includes(key))
	) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', `${name} is invalid`);
	}
}

function identifier(value: unknown, name: string, max = 200): string {
	if (typeof value !== 'string') {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', `${name} is invalid`);
	}
	const normalized = value.trim();
	if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', `${name} is invalid`);
	}
	return normalized;
}

function nullableIdentifier(value: unknown, name: string, max = 200): string | null {
	if (value === null) return null;
	return identifier(value, name, max);
}

function date(value: unknown, name: string): Date {
	if (typeof value !== 'string') {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', `${name} is invalid`);
	}
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', `${name} is invalid`);
	}
	return parsed;
}

function parseIdentity(value: unknown): PreviewControlIdentity {
	const input = object(value, 'preview diagnostics identity');
	exactKeys(input, IDENTITY_KEYS, 'preview diagnostics identity');
	try {
		return validatePreviewControlIdentity(input as unknown as PreviewControlIdentity);
	} catch {
		throw new PreviewWorkflowDiagnosticsError(
			'invalid-request',
			'preview diagnostics identity is invalid'
		);
	}
}

function parseExecution(value: unknown): WorkflowDiagnosticsExecution {
	const input = object(value, 'preview diagnostics execution');
	exactKeys(input, EXECUTION_KEYS, 'preview diagnostics execution');
	const startedAt = date(input.startedAt, 'execution startedAt');
	const completedAt = input.completedAt === null ? null : date(input.completedAt, 'execution completedAt');
	if (completedAt && completedAt.getTime() < startedAt.getTime()) {
		throw new PreviewWorkflowDiagnosticsError(
			'invalid-request',
			'execution completion precedes its start'
		);
	}
	if (typeof input.status !== 'string' || !STATUSES.has(input.status)) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', 'execution status is invalid');
	}
	const primaryTraceId = nullableIdentifier(input.primaryTraceId, 'primaryTraceId', 64);
	if (primaryTraceId && !/^[a-f0-9]+$/i.test(primaryTraceId)) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', 'primaryTraceId is invalid');
	}
	return {
		id: identifier(input.id, 'execution id'),
		userId: identifier(input.userId, 'execution user id'),
		projectId: identifier(input.projectId, 'execution project id'),
		status: input.status as WorkflowDiagnosticsExecution['status'],
		startedAt,
		completedAt,
		primaryTraceId,
		workflowSessionId: nullableIdentifier(input.workflowSessionId, 'workflowSessionId'),
		output: null,
		executionIr: null
	};
}

function parseCommand(body: Record<string, unknown>): PreviewWorkflowDiagnosticsBrokerCommand {
	exactKeys(body, BODY_KEYS, 'preview diagnostics command');
	const identity = parseIdentity(body.identity);
	const operation = body.operation;
	if (typeof operation !== 'string' || !OPERATIONS.has(operation as PreviewWorkflowDiagnosticsOperation)) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', 'diagnostics operation is invalid');
	}
	const authorization = identifier(body.authorization, 'diagnostics authorization', 2_048);
	const request = object(body.request, 'diagnostics request');
	return {
		identity,
		authorization,
		operation: operation as PreviewWorkflowDiagnosticsOperation,
		execution: parseExecution(body.execution),
		request
	};
}

/** Exact-tuple physical deep diagnostics. ClickHouse authority never enters a preview. */
export const POST: RequestHandler = async ({ request }) => {
	if (
		(env.PREVIEW_CONTROL_BROKER_MODE ?? process.env.PREVIEW_CONTROL_BROKER_MODE ?? '')
			.trim()
			.toLowerCase() !== 'true'
	) {
		return json({ ok: false, error: 'not found' }, { status: 404 });
	}

	try {
		const body = await readBoundedJsonObject(request, MAX_REQUEST_BYTES);
		const command = parseCommand(body);
		requirePreviewControlCapability(request, command.identity);
		const result = await getApplicationAdapters().previewWorkflowDiagnosticsBroker.execute(command);
		return json(
			redactDiagnosticEvidence({ ok: true, identity: command.identity, result }),
			{ headers: { 'cache-control': 'no-store' } }
		);
	} catch (cause) {
		if (cause instanceof BoundedJsonBodyError) {
			return json({ ok: false, error: cause.message }, { status: cause.statusCode });
		}
		if (cause instanceof PreviewWorkflowDiagnosticsError) {
			const status =
				cause.code === 'invalid-request'
					? 400
					: cause.code === 'not-authorized'
						? 403
						: cause.code === 'not-found'
							? 404
							: cause.code === 'contract-mismatch'
								? 409
								: 503;
			return json({ ok: false, error: cause.message, code: cause.code }, { status });
		}
		if (cause instanceof PreviewControlSourceAuthorityError) {
			const status =
				cause.code === 'not-found'
					? 404
					: cause.code === 'owner-not-admin'
						? 403
						: 409;
			return json({ ok: false, error: cause.message, code: cause.code }, { status });
		}
		if (isHttpError(cause)) throw cause;
		return json(
			{ ok: false, error: 'physical preview diagnostics are unavailable', code: 'unavailable' },
			{ status: 503 }
		);
	}
};
