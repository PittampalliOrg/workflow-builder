/**
 * Realistic fixtures for the UI-evidence screenshot run (goal-CHECK, track U5).
 * Shapes mirror the wire types exactly:
 *  - `PreviewDriftOverview` / `VclusterPreviewSummary` / `VclusterPreviewCounts`
 *    / `PrPreviewListItem` (src/lib/types/dev-previews.ts)
 *  - `DeploymentMetadataResponse` / `FleetDriftExtras`
 *    (src/lib/types/deployment-metadata.ts)
 *  - `PromotionStrategiesResponse` (src/lib/server/promoter/types.ts)
 *  - the `/api/workflows/executions/{id}/versions` body the checkpoints panel
 *    + sync-generation timeline consume.
 *
 * The fleet tells one coherent story:
 *  - pr-4381-preview-fix: hot ephemeral PR preview, one service BEHIND-PIN,
 *    promoted twice (receipt PR #4381 also exists in the PR-preview lane →
 *    dedupe badge).
 *  - agent-goal-mspd: RETAINED environment with a TTL countdown, agent
 *    editing, one service DIVERGED (agent-built candidate image).
 *  - demo-topology: SLEPT live-mode preview with NO capture receipt →
 *    uncaptured-sleep revert warning.
 */

const MAIN_SHA = "bd4dce2e39b69765a28520329cacebb70fecb335";
const OLD_SHA = "1f3c9a72e8b64d5f90a1c27d3e4b5a6978cd0e12";
const STACKS_SHA = "7b33ab3a0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f";
const CANDIDATE_SHA = "e349ca00d4c8b86a812b910fe44cc94aa02219fe";
const WB_REPO = "https://github.com/PittampalliOrg/workflow-builder";
const STACKS_REPO = "https://github.com/PittampalliOrg/stacks";
const EXECUTION_ID = "lite-dev-exec-evidence";

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const isoIn = (msAhead: number) => new Date(now + msAhead).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;

/* ── Dev hub: vcluster previews + counts ─────────────────────────────── */

const basePreview = {
	targetCluster: "dev",
	pool: null as string | null,
	legacyOrigin: null as "user" | "pr" | null,
	prNumber: null as number | null,
	protected: false,
	bootSeconds: null as number | null,
	platformRevision: STACKS_SHA.slice(0, 12),
	sourceRevision: MAIN_SHA,
	lane: "application" as const,
	provenance: null as Record<string, unknown> | null,
	trustedCode: true,
	allocation: { kind: "cold" as const },
	catalogDigest: "sha256:9c1f2e3d4c5b6a798877665544332211ffeeddccbbaa99887766554433221100",
};

export const vclusterPreviews = {
	previews: [
		{
			...basePreview,
			name: "pr-4381-preview-fix",
			phase: "ready",
			ready: true,
			url: "https://pr-4381-preview-fix.preview.dev.example.com",
			state: "hot",
			lifecycle: "ephemeral",
			origin: { kind: "pull-request", reference: "4381" },
			legacyOrigin: "pr",
			prNumber: 4381,
			prUrl: `${WB_REPO}/pull/4381`,
			expiresAt: isoIn(3 * HOUR + 12 * MIN),
			lastActive: iso(9 * MIN),
			profile: "app-live",
			mode: "live",
			owner: { kind: "automation", id: "pr-preview-controller" },
			services: ["workflow-builder", "mcp-gateway"],
			images: {
				"workflow-builder": `ghcr.io/pittampalliorg/workflow-builder:git-${OLD_SHA.slice(0, 40)}`,
				"mcp-gateway": `ghcr.io/pittampalliorg/mcp-gateway:git-${MAIN_SHA}`,
			},
		},
		{
			...basePreview,
			name: "agent-goal-mspd",
			phase: "ready",
			ready: true,
			url: "https://agent-goal-mspd.preview.dev.example.com",
			state: "hot",
			lifecycle: "retained",
			origin: { kind: "workflow", reference: EXECUTION_ID },
			expiresAt: isoIn(26 * HOUR + 40 * MIN),
			lastActive: iso(3 * MIN),
			profile: "app-live",
			mode: "live",
			owner: { kind: "workflow", id: EXECUTION_ID },
			services: ["workflow-builder"],
			provenance: { executionId: EXECUTION_ID },
			images: {
				"workflow-builder": `ghcr.io/pittampalliorg/workflow-builder:candidate-${CANDIDATE_SHA.slice(0, 12)}`,
			},
			prUrl: null,
		},
		{
			...basePreview,
			name: "demo-topology",
			phase: "slept",
			ready: false,
			url: null,
			state: "slept",
			lifecycle: "ephemeral",
			origin: { kind: "user", reference: "dev@workflow-builder.local" },
			expiresAt: isoIn(80 * HOUR),
			lastActive: iso(3 * HOUR + 20 * MIN),
			profile: "app-live",
			mode: "live",
			owner: { kind: "user", id: "lite-dev-user" },
			services: ["workflow-builder"],
			images: null,
			prUrl: null,
		},
	],
	counts: {
		awake: 2,
		slept: 1,
		total: 3,
		baking: 0,
		free: 1,
		claimed: 1,
		recycling: 0,
		max: 4,
		totalMax: 12,
		poolSize: 2,
	},
};

/* ── Dev hub: drift overview ─────────────────────────────────────────── */

const wbPin = {
	tag: `git-${MAIN_SHA}`,
	digest: "sha256:bb10aa20cc30dd40ee50ff60aa70bb80cc90dd00ee10ff20aa30bb40cc50dd60",
	commitSha: MAIN_SHA,
};
const gwPin = {
	tag: `git-${MAIN_SHA}`,
	digest: "sha256:1234abcd5678ef901234abcd5678ef901234abcd5678ef901234abcd5678ef90",
	commitSha: MAIN_SHA,
};

export const previewDriftOverview = {
	generatedAt: iso(0),
	repoHeads: {
		workflowBuilderMainSha: MAIN_SHA,
		stacksMainSha: STACKS_SHA,
	},
	previews: [
		{
			name: "pr-4381-preview-fix",
			phase: "ready",
			state: "hot",
			lifecycle: "ephemeral",
			stage: "promoted",
			syncGeneration: "gen-9f2ac410b7",
			services: [
				{
					service: "workflow-builder",
					running: {
						image: `ghcr.io/pittampalliorg/workflow-builder:git-${OLD_SHA}`,
						tag: `git-${OLD_SHA}`,
						digest: "sha256:77deadbeef11223344556677889900aabbccddeeff00112233445566778899aa",
						ready: true,
					},
					runningUnavailableReason: null,
					pin: wbPin,
					driftStatus: "behind-pin",
				},
				{
					service: "mcp-gateway",
					running: {
						image: `ghcr.io/pittampalliorg/mcp-gateway:git-${MAIN_SHA}`,
						tag: `git-${MAIN_SHA}`,
						digest: gwPin.digest,
						ready: true,
					},
					runningUnavailableReason: null,
					pin: gwPin,
					driftStatus: "in-sync",
				},
			],
			receipts: [
				{
					prNumber: 4381,
					prUrl: `${WB_REPO}/pull/4381`,
					commitSha: OLD_SHA,
					createdAt: iso(50 * MIN),
				},
				{
					prNumber: 4377,
					prUrl: `${WB_REPO}/pull/4377`,
					commitSha: "0aa1bb2cc3dd4ee5ff607182930a4b5c6d7e8f90",
					createdAt: iso(4 * HOUR),
				},
			],
		},
		{
			name: "agent-goal-mspd",
			phase: "ready",
			state: "hot",
			lifecycle: "retained",
			stage: "agent-editing",
			syncGeneration: "gen-4d81c209aa",
			services: [
				{
					service: "workflow-builder",
					running: {
						image: `ghcr.io/pittampalliorg/workflow-builder:candidate-${CANDIDATE_SHA.slice(0, 12)}`,
						tag: `candidate-${CANDIDATE_SHA.slice(0, 12)}`,
						digest: "sha256:44cafe0011223344556677889900aabbccddeeff00112233445566778899aabb",
						ready: true,
					},
					runningUnavailableReason: null,
					pin: wbPin,
					driftStatus: "diverged",
				},
			],
			receipts: [],
		},
		{
			name: "demo-topology",
			phase: "slept",
			state: "slept",
			lifecycle: "ephemeral",
			stage: "sleeping",
			syncGeneration: null,
			services: [
				{
					service: "workflow-builder",
					running: null,
					runningUnavailableReason: "slept",
					pin: wbPin,
					driftStatus: "unknown",
				},
			],
			receipts: [],
		},
	],
};

/* ── Dev hub: environment groups + PR previews ───────────────────────── */

const groupService = {
	executionId: EXECUTION_ID,
	workspaceRef: "agent-goal-mspd",
	service: "workflow-builder",
	browseUrl: "https://agent-goal-mspd.preview.dev.example.com",
	podIP: "10.42.3.17",
	port: 3000,
	syncUrl: "http://10.42.3.17:8384",
	ready: true,
	needsDapr: true,
	daprAppId: "workflow-builder",
	sandboxName: "agent-goal-mspd-workflow-builder",
	sessionId: "lite-session-1",
	sessionUrl: "/sessions/lite-session-1",
	runStatus: "running",
	createdAt: iso(42 * MIN),
	requestedServices: ["workflow-builder"],
};

export const devEnvironmentGroups = [
	{
		executionId: EXECUTION_ID,
		services: [groupService],
		primary: groupService,
		ready: true,
		sessionId: "lite-session-1",
		sessionUrl: "/sessions/lite-session-1",
		runStatus: "running",
		createdAt: iso(42 * MIN),
	},
];

export const prPreviews = {
	enabled: true,
	items: [
		{
			prNumber: 4381,
			alias: "pr-4381",
			url: "https://pr-4381.preview.dev.example.com",
			prUrl: `${WB_REPO}/pull/4381`,
			state: "ready",
			headSha: OLD_SHA,
			services: ["workflow-builder", "mcp-gateway"],
			error: null,
			verify: { state: "completed", reason: null, verdict: "pass" },
			updatedAt: iso(11 * MIN),
		},
		{
			prNumber: 4402,
			alias: "pr-4402",
			url: null,
			prUrl: `${WB_REPO}/pull/4402`,
			state: "provisioning",
			headSha: "9e8d7c6b5a493827161504f3e2d1c0b9a8978685",
			services: ["workflow-builder"],
			error: null,
			verify: { state: "started", reason: null, verdict: null },
			updatedAt: iso(2 * MIN),
		},
	],
};

/* ── Execution detail: environment + versions (timeline) ─────────────── */

export const devEnvironmentDetail = {
	environment: groupService,
	services: [groupService],
};

export const sidecarStatus = {
	service: "workflow-builder",
	status: {
		ok: true,
		data: {
			preparedOperationId: null,
			preparedAt: null,
			frozenOperationId: null,
			commands: ["typecheck", "test", "lint"],
			lastRun: {
				cmd: "typecheck",
				exitCode: 0,
				durationMs: 41_300,
				executedIn: "app",
				finishedAt: iso(6 * MIN),
			},
		},
	},
	allowedCommands: ["typecheck", "test", "lint"],
};

const versionBase = {
	executionId: EXECUTION_ID,
	nodeId: "dev-preview",
	fileId: null,
	sizeBytes: 48_128,
	title: null,
};

export const executionVersions = {
	versions: [
		{
			...versionBase,
			artifactId: "art-gen4-accepted",
			createdAt: iso(8 * MIN),
			payload: {
				tier: "vcluster",
				iteration: 4,
				services: ["workflow-builder"],
				serviceCount: 1,
				generation: "gen-4d81c209aa77f2b8",
				captureProtocol: "atomic-generation-v2",
			},
			promotion: {
				prUrl: `${WB_REPO}/pull/4405`,
				branch: "preview/agent-goal-mspd",
				commitSha: CANDIDATE_SHA,
				promotedAt: iso(5 * MIN),
				receiptId: "rcpt-4405",
				repository: "PittampalliOrg/workflow-builder",
				pullRequestNumber: 4405,
			},
			acceptance: { ok: true, acceptedAt: iso(3 * MIN), receiptId: "acc-1" },
		},
		{
			...versionBase,
			artifactId: "art-gen3-failed",
			createdAt: iso(52 * MIN),
			payload: {
				tier: "vcluster",
				iteration: 3,
				services: ["workflow-builder"],
				serviceCount: 1,
				generation: "gen-3c70ab1194e0d5c1",
				captureProtocol: "atomic-generation-v2",
			},
			promotion: {
				prUrl: `${WB_REPO}/pull/4405`,
				branch: "preview/agent-goal-mspd",
				commitSha: "5544332211ffeeddccbbaa998877665544332211",
				promotedAt: iso(49 * MIN),
				receiptId: "rcpt-4405-2",
				repository: "PittampalliOrg/workflow-builder",
				pullRequestNumber: 4405,
			},
			acceptance: { ok: false, acceptedAt: iso(47 * MIN), receiptId: "acc-2" },
		},
		{
			...versionBase,
			artifactId: "art-gen2-captured",
			createdAt: iso(2 * HOUR),
			payload: {
				tier: "vcluster",
				iteration: 2,
				services: ["workflow-builder", "mcp-gateway"],
				serviceCount: 2,
				generation: "gen-2b44f00c3d1e9a72",
				captureProtocol: "atomic-generation-v2",
			},
			promotion: null,
			acceptance: null,
		},
		{
			...versionBase,
			artifactId: "art-legacy-bundle",
			createdAt: iso(3 * HOUR),
			payload: { tier: "vcluster", iteration: 1, services: ["workflow-builder"], serviceCount: 1 },
			promotion: null,
			acceptance: null,
		},
	],
	unpromotedCount: 1,
	canManageStrictCheckpoints: true,
	latestStrictArtifactId: "art-gen4-accepted",
};

/* ── GitOps: deployment metadata snapshot ────────────────────────────── */

function commitMeta(sha: string, message: string, msAgo: number) {
	return {
		sha,
		shortSha: sha.slice(0, 8),
		url: `${WB_REPO}/commit/${sha}`,
		message,
		authorName: "outer-loop",
		committedAt: iso(msAgo),
	};
}

const PIN_SERVICES: Array<[name: string, sha: string, msAgo: number]> = [
	["workflow-builder", MAIN_SHA, 2 * HOUR],
	["workflow-mcp-server", MAIN_SHA, 2 * HOUR],
	["mcp-gateway", MAIN_SHA, 2 * HOUR],
	["function-router", OLD_SHA, 26 * HOUR],
	["workflow-orchestrator", OLD_SHA, 26 * HOUR],
	["code-parser", MAIN_SHA, 2 * HOUR],
	["code-runtime", MAIN_SHA, 2 * HOUR],
	["workspace-runtime", MAIN_SHA, 2 * HOUR],
];

function inventoryApp(
	env: string,
	component: string,
	opts: {
		desiredSha: string;
		liveSha?: string;
		syncStatus?: string;
		healthStatus?: string;
		driftStatus?: string;
		healthPhase?: string;
		buildReason?: string;
		pipelineRun?: string | null;
	},
) {
	const liveSha = opts.liveSha ?? opts.desiredSha;
	return {
		name: `${env}-${component}`,
		component,
		desired: {
			image: `ghcr.io/pittampalliorg/${component}:git-${opts.desiredSha}`,
			tag: `git-${opts.desiredSha}`,
			digest: null,
			commitSha: opts.desiredSha,
		},
		live: {
			images: [`ghcr.io/pittampalliorg/${component}:git-${liveSha}`],
			syncStatus: opts.syncStatus ?? "Synced",
			healthStatus: opts.healthStatus ?? "Healthy",
		},
		promotion: {
			drySha: opts.desiredSha,
			hydratedSha: opts.desiredSha.slice(0, 8),
			healthPhase: opts.healthPhase ?? "Succeeded",
		},
		build: {
			pipelineRun: opts.pipelineRun ?? `${component}-build-run-8kx2p`,
			status: opts.buildReason === "Failed" ? "False" : "True",
			reason: opts.buildReason ?? "Succeeded",
			startedAt: iso(3 * HOUR),
			finishedAt: iso(3 * HOUR - 4 * MIN),
		},
		provenance: { "org.opencontainers.image.created": iso(3 * HOUR) },
		drift: { status: opts.driftStatus ?? "in_sync" },
	};
}

export const gitopsMetadata = {
	generatedAt: iso(0),
	environment: {
		name: "dev",
		namespace: "workflow-builder",
		appUrl: "https://workflow-builder-dev.tail286401.ts.net",
		nodeEnv: "production",
		podName: "workflow-builder-7f9c65d4b8-x2krw",
		detectedFrom: "release-pins",
	},
	gitops: {
		releasePinsSourceUrl: `${STACKS_REPO}/blob/main/packages/components/hub-spoke-appsets/release-pins/workflow-builder-images.yaml`,
		releasePinsFetchedAt: iso(40_000),
		releasePinsError: null,
		stacksMain: {
			sha: STACKS_SHA,
			shortSha: STACKS_SHA.slice(0, 8),
			url: `${STACKS_REPO}/commit/${STACKS_SHA}`,
			message: "chore(outer-loop): update workflow-builder image to git-bd4dce2e",
			authorName: "outer-loop",
			committedAt: iso(2 * HOUR),
		},
		desiredImages: PIN_SERVICES.map(([name, sha, msAgo]) => ({
			name,
			tag: `git-${sha}`,
			commitSha: sha,
			commit: commitMeta(sha, `chore(dev-images): bump ${name} to git-${sha.slice(0, 8)}`, msAgo),
			digest: name === "workflow-builder" ? wbPin.digest : null,
			updatedAt: iso(msAgo),
		})),
		imageHistory: [
			{
				service: "workflow-builder",
				tag: `git-${MAIN_SHA}`,
				digest: wbPin.digest,
				sourceSha: MAIN_SHA,
				committedAt: iso(2 * HOUR),
				pinCommit: STACKS_SHA,
				pinCommittedAt: iso(2 * HOUR),
				message: "chore(dev-images): rebuild + bump dev-preview image pins",
			},
			{
				service: "workflow-builder",
				tag: `git-${OLD_SHA}`,
				digest: "sha256:77deadbeef11223344556677889900aabbccddeeff00112233445566778899aa",
				sourceSha: OLD_SHA,
				committedAt: iso(30 * HOUR),
				pinCommit: "aa00bb11cc22dd33ee44ff5566778899aabbccdd",
				pinCommittedAt: iso(30 * HOUR),
				message: "chore(dev-images): bump workflow-builder",
			},
		],
		imageHistoryError: null,
	},
	live: {
		deployments: [
			{
				name: "workflow-builder",
				namespace: "workflow-builder",
				labels: { "app.kubernetes.io/name": "workflow-builder" },
				replicas: 2,
				readyReplicas: 2,
				availableReplicas: 2,
				updatedReplicas: 2,
				createdAt: iso(72 * HOUR),
				updatedAt: iso(2 * HOUR),
				pods: {
					total: 2,
					running: 2,
					ready: 2,
					names: ["workflow-builder-7f9c65d4b8-x2krw", "workflow-builder-7f9c65d4b8-m1pqz"],
				},
				containers: [
					{
						containerName: "workflow-builder",
						image: `ghcr.io/pittampalliorg/workflow-builder:git-${MAIN_SHA}`,
						repository: "ghcr.io/pittampalliorg",
						name: "workflow-builder",
						tag: `git-${MAIN_SHA}`,
						digest: null,
						commitSha: MAIN_SHA,
						imageID: `ghcr.io/pittampalliorg/workflow-builder@${wbPin.digest}`,
						ready: true,
						restartCount: 0,
						desiredTag: `git-${MAIN_SHA}`,
						desiredCommitSha: MAIN_SHA,
						desiredMatches: true,
						commit: commitMeta(MAIN_SHA, "Compose Kimi K3 tools with structured output", 2 * HOUR),
						pinKey: "workflow-builder",
					},
				],
			},
		],
		error: null,
	},
	inventory: {
		sourceUrl: "https://gitops-inventory-hub.tail286401.ts.net/inventory.json",
		fetchedAt: iso(25_000),
		error: null,
		data: {
			generatedAt: iso(60_000),
			source: "hub-inventory",
			releasePins: { images: {}, error: null },
			environments: [
				{
					name: "dev",
					applications: [
						inventoryApp("dev", "workflow-builder", { desiredSha: MAIN_SHA }),
						inventoryApp("dev", "workflow-mcp-server", { desiredSha: MAIN_SHA }),
						inventoryApp("dev", "mcp-gateway", { desiredSha: MAIN_SHA }),
						inventoryApp("dev", "function-router", {
							desiredSha: OLD_SHA,
							liveSha: "0011223344556677889900aabbccddeeff001122",
							syncStatus: "OutOfSync",
							driftStatus: "pending_rollout",
						}),
						inventoryApp("dev", "workflow-orchestrator", {
							desiredSha: OLD_SHA,
							healthStatus: "Degraded",
							healthPhase: "Failure",
							buildReason: "Failed",
							pipelineRun: "workflow-orchestrator-build-run-4fd1x",
						}),
						inventoryApp("dev", "code-parser", { desiredSha: MAIN_SHA }),
						inventoryApp("dev", "code-runtime", { desiredSha: MAIN_SHA }),
						inventoryApp("dev", "workspace-runtime", { desiredSha: MAIN_SHA }),
					],
				},
				{
					name: "staging",
					applications: [
						inventoryApp("staging", "workflow-builder", {
							desiredSha: OLD_SHA,
							syncStatus: "OutOfSync",
							driftStatus: "pending_rollout",
						}),
						inventoryApp("staging", "workflow-mcp-server", { desiredSha: OLD_SHA }),
						inventoryApp("staging", "mcp-gateway", { desiredSha: OLD_SHA }),
						inventoryApp("staging", "function-router", { desiredSha: OLD_SHA }),
						inventoryApp("staging", "workflow-orchestrator", { desiredSha: OLD_SHA }),
						inventoryApp("staging", "code-parser", { desiredSha: OLD_SHA }),
						inventoryApp("staging", "code-runtime", { desiredSha: OLD_SHA }),
						inventoryApp("staging", "workspace-runtime", { desiredSha: OLD_SHA }),
					],
				},
			],
		},
	},
};

/* ── GitOps: fleet-drift extras (incl. the broker-SKEW datum) ────────── */

export const fleetDriftExtras = {
	generatedAt: iso(0),
	workflowBuilderMainHead: commitMeta(
		MAIN_SHA,
		"Compose Kimi K3 tools with structured output (#689)",
		2 * HOUR,
	),
	stacksMainHead: {
		sha: STACKS_SHA,
		shortSha: STACKS_SHA.slice(0, 8),
		url: `${STACKS_REPO}/commit/${STACKS_SHA}`,
		message: "chore(outer-loop): update workflow-builder image to git-bd4dce2e",
		authorName: "outer-loop",
		committedAt: iso(2 * HOUR),
	},
	pinAges: PIN_SERVICES.map(([service, , msAgo]) => ({
		service,
		updatedAt: iso(msAgo),
		ageMs: msAgo,
	})),
	newestBuilt: PIN_SERVICES.map(([service, sha]) => ({
		service,
		newestTag: `git-${sha}`,
		newestPinCommittedAt: iso(2 * HOUR),
		inFlightPipelineRun: service === "workflow-orchestrator" ? "workflow-orchestrator-build-run-9zz4p" : null,
	})),
	previewPlatform: {
		pinRevision: "f4a9c1e07d2b5836",
		brokerImageDigest: "sha256:0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
		releasePinsWorkflowBuilderDigest: wbPin.digest,
		skew: true,
	},
	liveDeployments: [
		{ name: "workflow-builder", generation: 42, observedGeneration: 42, converged: true },
		{ name: "workflow-orchestrator", generation: 17, observedGeneration: 16, converged: false },
	],
};

/* ── GitOps: promotion strategies ────────────────────────────────────── */

export const gitopsPromotions = {
	generatedAt: iso(30_000),
	source: "hub-inventory",
	strategies: [
		{
			apiVersion: "promoter.argoproj.io/v1alpha1",
			kind: "PromotionStrategy",
			metadata: {
				name: "workflow-builder",
				namespace: "promoter-system",
				creationTimestamp: iso(400 * HOUR),
			},
			spec: {
				gitRepositoryRef: { name: "stacks" },
				environments: [{ branch: "env/dev-next" }, { branch: "env/hub", autoMerge: false }],
			},
			status: {
				environments: [
					{
						branch: "env/dev-next",
						active: {
							dry: { sha: STACKS_SHA, subject: "chore(outer-loop): bump workflow-builder", commitTime: iso(2 * HOUR) },
							hydrated: { sha: "11aa22bb33cc44dd55ee66ff77aa88bb99cc00dd" },
							commitStatuses: [{ key: "argocd-health", phase: "success" }],
						},
						proposed: {
							dry: { sha: STACKS_SHA },
							commitStatuses: [{ key: "argocd-health", phase: "success" }],
						},
					},
					{
						branch: "env/hub",
						active: {
							dry: {
								sha: "99ff88ee77dd66cc55bb44aa33221100ffeeddcc",
								subject: "previous hub promotion",
								commitTime: iso(30 * HOUR),
							},
							hydrated: { sha: "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00" },
							commitStatuses: [{ key: "argocd-health", phase: "success" }],
						},
						proposed: {
							dry: { sha: STACKS_SHA, subject: "chore(outer-loop): bump workflow-builder" },
							hydrated: { sha: "bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11" },
							commitStatuses: [{ key: "argocd-health", phase: "pending" }],
						},
					},
				],
			},
		},
	],
	changeTransferPolicies: [],
	pullRequests: [
		{
			apiVersion: "promoter.argoproj.io/v1alpha1",
			kind: "PullRequest",
			metadata: {
				name: "workflow-builder-env-hub",
				namespace: "promoter-system",
				labels: { "promoter.argoproj.io/promotion-strategy": "workflow-builder" },
			},
			spec: {
				sourceBranch: "env/hub-next",
				targetBranch: "env/hub",
				title: "Promote workflow-builder to env/hub",
				state: "open",
			},
			status: { id: 4409 },
		},
	],
	commitStatuses: [],
	error: null,
};
