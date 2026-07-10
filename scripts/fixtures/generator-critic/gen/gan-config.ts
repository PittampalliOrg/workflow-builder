/**
 * Typed configuration for the preview-family GAN fixture generator.
 *
 * Only `grounding: "preview-adopted"` and `domain: "ui-web"` are implemented in
 * this pass; the other enum members are declared so the shape is stable for the
 * follow-up cut-overs (preview-gan-redesign etc.) but are intentionally not yet
 * wired in the generator.
 */

export type GanGrounding = "preview-adopted" | "preview-service" | "clone";
export type GanDomain = "ui-web";

export interface GatePhaseSeconds {
	install: number;
	check: number;
	boundaries: number;
	testUnit: number;
}

export interface GanTimeouts {
	/** dev/preview ensure wait, seconds. */
	previewWaitReadySeconds: number;
	/** dev/preview lease, seconds. */
	previewTimeoutSeconds: number;
	/** per-gate-phase `timeout` wrapper, seconds (svelte-check is the long pole). */
	gatePhaseSeconds: GatePhaseSeconds;
	/** overall gate node timeout, ms. */
	gateTimeoutMs: number;
	/** helper-pod pin lease for cliWorkspace command nodes, minutes. */
	helperTimeoutMinutes: number;
}

export interface GanPromoteConfig {
	repoUrl: string;
	/** output modes exposed on the trigger enum. */
	modes: string[];
}

export interface GanDefaults {
	generatorAgent: string;
	criticAgent: string;
	acceptScore: number;
	maxIterations: number;
	stallWindow: number;
	previewLogin: string;
	previewPassword: string;
	evaluationRoutes: string[];
	service: string;
	outputMode: string;
	timeouts: GanTimeouts;
}

export interface GanFixtureConfig {
	name: string;
	/** DSL document version (semver-ish string). */
	version: string;
	namespace: string;
	title: string;
	summary: string;
	grounding: GanGrounding;
	domain: GanDomain;
	defaults: GanDefaults;
	promote: GanPromoteConfig;
}

export const DEFAULT_TIMEOUTS: GanTimeouts = {
	previewWaitReadySeconds: 240,
	previewTimeoutSeconds: 86400,
	// svelte-check on 9920 files is the long pole (~94s); install ~30s cold.
	gatePhaseSeconds: { install: 300, check: 420, boundaries: 180, testUnit: 420 },
	gateTimeoutMs: 1500000,
	helperTimeoutMinutes: 240,
};

/** The one config that must work now: the adopted workflow-builder BFF, ui-web. */
export const PREVIEW_GAN_UI_FEATURE_CONFIG: GanFixtureConfig = {
	name: "preview-gan-ui-feature",
	version: "0.1.0",
	namespace: "demos",
	title:
		"In-preview GAN UI-feature loop (Planner -> two-pass design -> Generator <-> skeptical Playwright critic) on the ADOPTED workflow-builder BFF -> PR",
	summary:
		"Generic UI-feature/refactor GAN loop running INSIDE a Tier-2 vcluster preview whose workflow-builder pod is ADOPTED by a hot-reload dev server (adopt:true: the dev pod becomes the BFF and the preview's own URL serves live edits). The Planner (gan-generator-ultracode: Opus 4.8 at ultracode effort) writes a TESTABLE JSON contract; a two-pass design_review critiques the token system BEFORE any code; then a refine loop has the GENERATOR pull the live source via GET /__export, edit ONLY src/, PUSH via POST /__sync (HMR), and smoke-check the routes — a deterministic gate then runs check + boundaries + test-unit against a full checkout of the synced src (this preview has NO /__run endpoint), while a skeptical Playwright critic LOGS IN and grades each evaluationRoute against the contract (default-reject) and writes a file-based verdict. Each iteration is captured as a promotable tar-overlay snapshot; when outputMode=pr the final source is opened as a pull request on PittampalliOrg/workflow-builder via the dev/preview-promote action. Kept GENERIC — the specific task is the run-time `intent`. No HITL/approval gate.",
	grounding: "preview-adopted",
	domain: "ui-web",
	defaults: {
		generatorAgent: "gan-generator-ultracode",
		criticAgent: "gan-critic-claude",
		acceptScore: 8,
		maxIterations: 5,
		stallWindow: 2,
		previewLogin: "admin@example.com",
		previewPassword: "developer",
		evaluationRoutes: ["/dashboard"],
		service: "workflow-builder",
		outputMode: "pr",
		timeouts: DEFAULT_TIMEOUTS,
	},
	promote: {
		repoUrl: "PittampalliOrg/workflow-builder",
		modes: ["pr", "preview-only"],
	},
};
