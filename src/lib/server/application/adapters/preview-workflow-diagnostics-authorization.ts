import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import type {
	PreviewWorkflowDiagnosticsAuthorizationInput,
	PreviewWorkflowDiagnosticsAuthorizationPort
} from '$lib/server/application/ports';
import { validatePreviewControlIdentity } from '$lib/server/application/preview-control-identity';
import {
	derivePreviewControlCapability,
	localPreviewControlCapability
} from '$lib/server/preview-control-capability';

const VERSION = 'pwd1';
const HEX_KEY = /^[0-9a-f]{64}$/;
const MAX_TOKEN_BYTES = 2_048;
const DEFAULT_TTL_MS = 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;

type AuthorizationClaims = Readonly<{
	v: 1;
	previewName: string;
	environmentRequestId: string;
	environmentPlatformRevision: string;
	environmentSourceRevision: string;
	catalogDigest: string;
	executionId: string;
	userId: string;
	projectId: string;
	startedAt: string;
	completedAt: string | null;
	primaryTraceId: string | null;
	workflowSessionId: string | null;
	operation: string;
	iat: number;
	exp: number;
}>;

type AuthorizationOptions = Readonly<{
	signingKey?: (input: PreviewWorkflowDiagnosticsAuthorizationInput) => string;
	verificationKey?: (input: PreviewWorkflowDiagnosticsAuthorizationInput) => string;
	now?: () => Date;
	ttlMs?: number;
}>;

function assertInput(input: PreviewWorkflowDiagnosticsAuthorizationInput): void {
	validatePreviewControlIdentity(input.identity);
	if (
		!input.execution.id.trim() ||
		!input.execution.userId.trim() ||
		!input.execution.projectId?.trim() ||
		!input.operation
	) {
		throw new Error('preview workflow diagnostics authorization scope is incomplete');
	}
}

function claimsFor(
	input: PreviewWorkflowDiagnosticsAuthorizationInput,
	iat: number,
	exp: number
): AuthorizationClaims {
	return {
		v: 1,
		previewName: input.identity.previewName,
		environmentRequestId: input.identity.environmentRequestId,
		environmentPlatformRevision: input.identity.environmentPlatformRevision,
		environmentSourceRevision: input.identity.environmentSourceRevision,
		catalogDigest: input.identity.catalogDigest,
		executionId: input.execution.id,
		userId: input.execution.userId,
		projectId: input.execution.projectId!,
		startedAt: input.execution.startedAt.toISOString(),
		completedAt: input.execution.completedAt?.toISOString() ?? null,
		primaryTraceId: input.execution.primaryTraceId,
		workflowSessionId: input.execution.workflowSessionId,
		operation: input.operation,
		iat,
		exp
	};
}

function signature(key: string, payload: string): Buffer {
	if (!HEX_KEY.test(key)) {
		throw new Error('preview workflow diagnostics authorization key is invalid');
	}
	return createHmac('sha256', Buffer.from(key, 'hex')).update(payload, 'utf8').digest();
}

function defaultVerificationKey(input: PreviewWorkflowDiagnosticsAuthorizationInput): string {
	const root = (
		env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
		process.env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
		''
	).trim();
	return derivePreviewControlCapability(root, input.identity);
}

function equalClaims(left: AuthorizationClaims, right: AuthorizationClaims): boolean {
	return (
		left.v === right.v &&
		left.previewName === right.previewName &&
		left.environmentRequestId === right.environmentRequestId &&
		left.environmentPlatformRevision === right.environmentPlatformRevision &&
		left.environmentSourceRevision === right.environmentSourceRevision &&
		left.catalogDigest === right.catalogDigest &&
		left.executionId === right.executionId &&
		left.userId === right.userId &&
		left.projectId === right.projectId &&
		left.startedAt === right.startedAt &&
		left.completedAt === right.completedAt &&
		left.primaryTraceId === right.primaryTraceId &&
		left.workflowSessionId === right.workflowSessionId &&
		left.operation === right.operation
	);
}

/** HMAC adapter: the preview has one tuple leaf; the physical broker has only its root. */
export class HmacPreviewWorkflowDiagnosticsAuthorizationAdapter
	implements PreviewWorkflowDiagnosticsAuthorizationPort
{
	private readonly now: () => Date;
	private readonly ttlMs: number;

	constructor(private readonly options: AuthorizationOptions = {}) {
		this.now = options.now ?? (() => new Date());
		this.ttlMs = Math.min(120_000, Math.max(5_000, options.ttlMs ?? DEFAULT_TTL_MS));
	}

	issue(input: PreviewWorkflowDiagnosticsAuthorizationInput): string {
		assertInput(input);
		const now = this.now().getTime();
		const payload = Buffer.from(
			JSON.stringify(claimsFor(input, now, now + this.ttlMs)),
			'utf8'
		).toString('base64url');
		const key = (this.options.signingKey ?? (() => localPreviewControlCapability()))(input);
		return `${VERSION}.${payload}.${signature(key, payload).toString('base64url')}`;
	}

	verify(token: string, input: PreviewWorkflowDiagnosticsAuthorizationInput): boolean {
		try {
			assertInput(input);
			if (!token || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) return false;
			const [version, payload, encodedSignature, extra] = token.split('.');
			if (version !== VERSION || !payload || !encodedSignature || extra) return false;
			const claims = JSON.parse(
				Buffer.from(payload, 'base64url').toString('utf8')
			) as AuthorizationClaims;
			if (!claims || typeof claims !== 'object') return false;
			const now = this.now().getTime();
			if (
				!Number.isFinite(claims.iat) ||
				!Number.isFinite(claims.exp) ||
				claims.iat > now + MAX_CLOCK_SKEW_MS ||
				claims.exp <= now ||
				claims.exp - claims.iat > 120_000
			) {
				return false;
			}
			if (!equalClaims(claims, claimsFor(input, claims.iat, claims.exp))) return false;
			const key = (this.options.verificationKey ?? defaultVerificationKey)(input);
			const expected = signature(key, payload);
			const supplied = Buffer.from(encodedSignature, 'base64url');
			return supplied.length === expected.length && timingSafeEqual(supplied, expected);
		} catch {
			return false;
		}
	}
}
