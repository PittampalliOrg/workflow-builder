import type {
	PreviewControlAdminAuthorizationPort,
	PreviewControlPullRequestInspectionPort,
	PreviewEnvironmentCandidatePathRoutingPort,
	PreviewInfrastructureCandidateBrokerPort,
	PreviewInfrastructureCandidateBrokerRequest,
	PreviewInfrastructureCandidateBrokerResult,
	PreviewInfrastructureCandidateLaunchPort,
} from "$lib/server/application/ports";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PREVIEW_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export class PreviewInfrastructureCandidateBrokerError extends Error {
	constructor(
		message: string,
		public readonly statusCode: 400 | 403 | 409 | 502 = 400,
	) {
		super(message);
		this.name = "PreviewInfrastructureCandidateBrokerError";
	}
}

type Deps = Readonly<{
	admins: PreviewControlAdminAuthorizationPort;
	pullRequests: PreviewControlPullRequestInspectionPort;
	paths: PreviewEnvironmentCandidatePathRoutingPort;
	environments: PreviewInfrastructureCandidateLaunchPort;
	platformRepository: string;
	sourceRef: string;
}>;

const CAPABILITY = {
	"manifest-candidate": "namespaced-manifests",
	"host-candidate": "host-control-plane",
} as const;

/** GitHub-verified infrastructure candidate admission on the physical broker. */
export class ApplicationPreviewInfrastructureCandidateBrokerService
	implements PreviewInfrastructureCandidateBrokerPort
{
	constructor(private readonly deps: Deps) {}

	async launch(
		input: PreviewInfrastructureCandidateBrokerRequest,
	): Promise<PreviewInfrastructureCandidateBrokerResult> {
		this.validate(input);
		if (!(await this.deps.admins.isPlatformAdmin(input.userId))) {
			throw new PreviewInfrastructureCandidateBrokerError(
				"platform admin approval is required for infrastructure candidates",
				403,
			);
		}
		let pullRequest;
		try {
			pullRequest = await this.deps.pullRequests.inspectOpen({
				repository: this.deps.platformRepository,
				number: input.pullRequestNumber,
			});
		} catch (cause) {
			throw new PreviewInfrastructureCandidateBrokerError(
				`infrastructure pull request was rejected: ${message(cause)}`,
				409,
			);
		}
		let routed;
		try {
			routed = this.deps.paths.routeCandidatePaths(pullRequest.changedPaths);
		} catch (cause) {
			throw new PreviewInfrastructureCandidateBrokerError(message(cause), 409);
		}
		if (routed.lane === "management" || routed.profile === "host-candidate") {
			return Object.freeze({
				ok: false as const,
				status: "operator-required" as const,
				profile: routed.profile,
				lane: routed.lane,
				pullRequest,
				changedPaths: routed.paths,
				launch: null,
				operatorAction: Object.freeze({
					command:
						routed.lane === "management"
							? ("preview-management-candidate.sh" as const)
							: ("preview-host-candidate.sh" as const),
					id: input.name,
					revision: pullRequest.headSha,
					candidatePaths: routed.paths,
				}),
			});
		}
		const lifecycle = input.lifecycle ?? "ephemeral";
		const parentEnvironmentId =
			`pull-request:${pullRequest.repository}#${pullRequest.number}@${pullRequest.headSha}`;
		let launch;
		try {
			launch = await this.deps.environments.launch({
				name: input.name,
				userId: input.userId,
				profile: routed.profile,
				lane: routed.lane,
				platformRevision: pullRequest.headSha,
				sourceRef: this.deps.sourceRef,
				capabilities: [CAPABILITY[routed.profile]],
				candidatePaths:
					routed.profile === "manifest-candidate" ? routed.paths : [],
				ttlHours: input.ttlHours ?? 24,
				lifecycle,
				parentEnvironmentId,
			});
		} catch (cause) {
			throw new PreviewInfrastructureCandidateBrokerError(
				`infrastructure candidate launch failed: ${message(cause)}`,
				502,
			);
		}
		return Object.freeze({
			ok: launch.ok,
			status: "launched" as const,
			profile: routed.profile,
			lane: routed.lane,
			pullRequest,
			changedPaths: routed.paths,
			launch,
		});
	}

	private validate(input: PreviewInfrastructureCandidateBrokerRequest): void {
		if (!SAFE_ID.test(input.requestId)) {
			throw new PreviewInfrastructureCandidateBrokerError("requestId is invalid");
		}
		if (!PREVIEW_NAME.test(input.name)) {
			throw new PreviewInfrastructureCandidateBrokerError("name is invalid");
		}
		if (!SAFE_ID.test(input.userId)) {
			throw new PreviewInfrastructureCandidateBrokerError("userId is invalid");
		}
		if (
			!Number.isInteger(input.pullRequestNumber) ||
			input.pullRequestNumber < 1
		) {
			throw new PreviewInfrastructureCandidateBrokerError(
				"pullRequestNumber must be a positive integer",
			);
		}
		if (
			input.ttlHours !== undefined &&
			(!Number.isInteger(input.ttlHours) ||
				input.ttlHours < 1 ||
				input.ttlHours > 168)
		) {
			throw new PreviewInfrastructureCandidateBrokerError(
				"ttlHours must be an integer from 1 to 168",
			);
		}
		if (
			input.lifecycle !== undefined &&
			!(["ephemeral", "retained"] as const).includes(input.lifecycle)
		) {
			throw new PreviewInfrastructureCandidateBrokerError(
				"lifecycle must be ephemeral or retained",
			);
		}
	}
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
