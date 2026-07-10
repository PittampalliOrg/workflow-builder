/**
 * Assembles the full SW 1.0 `preview-gan-ui-feature` fixture from a
 * GanFixtureConfig + the hardened fragments. The overall document/input/output/do
 * structure mirrors the pre-generator fixture exactly; only the gate, verdict,
 * promote, while and summary parts carry the hardened conventions.
 */
import type { GanFixtureConfig } from "./gan-config";
import { buildWhile, buildSummarySet } from "./fragments/conditions";
import { buildGateNode } from "./fragments/gate";
import {
	CRITIC_INSTRUCTIONS,
	critiquePrompt,
	DESIGN_REVIEW_INSTRUCTIONS,
	designReviewPrompt,
	generatePrompt,
	planPrompt,
	PLANNER_GENERATOR_INSTRUCTIONS,
} from "./fragments/personas";
import { buildPromoteNode } from "./fragments/promote";
import { buildReadVerdictNode } from "./fragments/verdict";
import { jqExpr } from "./jq";

type Json = Record<string, unknown>;

function inputSchemaProperties(cfg: GanFixtureConfig): Json {
	const d = cfg.defaults;
	return {
		intent: {
			type: "string",
			title: "Feature / refactor request",
			default:
				"Describe the UI feature or refactor you want on the workflow-builder app. State the goal, the user and the job the surface must do, what matters MOST, and what to AVOID. This drives a Planner -> Generator <-> skeptical Playwright Critic loop: the Planner writes a TESTABLE JSON contract, the Generator builds it against the live hot-reloading preview (edit src/, /__sync), and the Critic logs in and grades the live routes. Requirements: pull REAL data via +page.server.ts (never fabricate; degrade gracefully to empty states), keep hexagonal-architecture discipline for server/data code, keep existing functionality intact, fully responsive and accessible (AA contrast, visible keyboard focus). Never touch the sign-in/auth pages.",
			description:
				"The change request that drives the loop (Planner writes a testable contract -> Generator builds it -> skeptical Playwright Critic grades the live routes). Freeform; be specific about the goal and what to avoid.",
		},
		service: {
			type: "string",
			title: "Service",
			default: d.service,
			description:
				"The preview service whose pod is adopted by a dev server (workflow-builder = the BFF).",
		},
		evaluationRoutes: {
			type: "array",
			title: "Evaluation routes",
			items: { type: "string" },
			default: d.evaluationRoutes,
			description:
				"Route paths the generator builds and the critic grades against the contract (authenticated).",
		},
		generatorAgent: {
			type: "string",
			title: "Generator/planner agent",
			default: d.generatorAgent,
			description:
				"Plans (writes the contract) AND edits repo/src. interactive-cli family (shares the run workspace). Defaults to the Opus 4.8 ultracode agent.",
		},
		criticAgent: {
			type: "string",
			title: "Critic agent",
			default: d.criticAgent,
			description:
				"Reviews the design tokens + drives Playwright MCP against the live preview and grades each evaluation route.",
		},
		previewLogin: {
			type: "string",
			title: "Preview login email",
			default: d.previewLogin,
			description:
				"Admin login the critic uses to reach the authenticated routes (seeded by the preview runner).",
		},
		previewPassword: {
			type: "string",
			title: "Preview login password",
			default: d.previewPassword,
		},
		maxIterations: {
			type: "integer",
			title: "Max refine iterations",
			default: d.maxIterations,
			description:
				"Upper bound on generate<->critique iterations; the loop also exits early once the critic accepts (score >= acceptScore) and the deterministic gate passes.",
		},
		acceptScore: {
			type: "integer",
			title: "Accept score",
			default: d.acceptScore,
			description:
				"Minimum critic score (0-10) for acceptance; the loop accepts only when meets_criteria AND score>=acceptScore AND the deterministic gate passes.",
		},
		stallWindow: {
			type: "integer",
			title: "Stall window",
			default: d.stallWindow,
			description:
				"No-progress window K: the loop stops early when the best score over the last K graded iterations does not beat the best of the earlier ones.",
		},
		outputMode: {
			type: "string",
			title: "Output mode",
			default: d.outputMode,
			enum: cfg.promote.modes,
			description:
				"pr = open a pull request on PittampalliOrg/workflow-builder from the final source; preview-only = stop after the loop without a PR.",
		},
	};
}

function inputSchema(cfg: GanFixtureConfig): Json {
	return {
		schema: {
			format: "json",
			document: {
				type: "object",
				required: ["intent"],
				properties: inputSchemaProperties(cfg),
			},
		},
	};
}

function enterDevModeNode(cfg: GanFixtureConfig): Json {
	return {
		enter_dev_mode: {
			call: "dev/preview",
			with: {
				executionId: jqExpr(".runtime.executionId"),
				service: jqExpr(
					`.trigger.service // "${cfg.defaults.service}"`,
				),
				mode: "preview-native",
				adopt: true,
				timeoutSeconds: cfg.defaults.timeouts.previewTimeoutSeconds,
				waitReadySeconds: cfg.defaults.timeouts.previewWaitReadySeconds,
			},
			artifacts: [
				{
					from: jqExpr(
						'{ service:(.data.service // ""), url:(.data.url // ""), syncUrl:(.data.syncUrl // ""), browseUrl:(.data.browseUrl // ""), ready:(.data.ready // false) }',
					),
					kind: "json",
					slot: "secondary",
					title: "Preview-native dev mode (adopted BFF)",
				},
			],
		},
	};
}

function planNode(cfg: GanFixtureConfig): Json {
	return {
		plan: {
			call: "durable/run",
			with: {
				cwd: "/sandbox/scratch",
				mode: "execute_direct",
				workspaceRef: jqExpr(".runtime.workspaceExecutionId"),
				agentRef: {
					slug: jqExpr(
						`.trigger.generatorAgent // "${cfg.defaults.generatorAgent}"`,
					),
				},
				agentConfig: {
					name: "Planner (contract author)",
					modelSpec: "claude-opus-4-8",
					effort: "ultracode",
					instructions: PLANNER_GENERATOR_INSTRUCTIONS,
				},
				body: {
					prompt: planPrompt(),
					overrides: {
						cwd: "/sandbox/scratch",
						maxTurns: 12,
						timeoutMinutes: 20,
					},
				},
			},
		},
	};
}

function designReviewNode(cfg: GanFixtureConfig): Json {
	return {
		design_review: {
			call: "durable/run",
			with: {
				cwd: "/sandbox/scratch",
				mode: "execute_direct",
				workspaceRef: jqExpr(".runtime.workspaceExecutionId"),
				agentRef: {
					slug: jqExpr(
						`.trigger.criticAgent // "${cfg.defaults.criticAgent}"`,
					),
				},
				agentConfig: {
					name: "Two-pass design review",
					instructions: DESIGN_REVIEW_INSTRUCTIONS,
				},
				body: {
					prompt: designReviewPrompt(),
					overrides: {
						cwd: "/sandbox/scratch",
						maxTurns: 6,
						timeoutMinutes: 15,
					},
				},
			},
		},
	};
}

function generateNode(cfg: GanFixtureConfig): Json {
	return {
		generate: {
			call: "durable/run",
			with: {
				cwd: "/sandbox/scratch",
				mode: "execute_direct",
				workspaceRef: jqExpr(".runtime.workspaceExecutionId"),
				agentRef: {
					slug: jqExpr(
						`.trigger.generatorAgent // "${cfg.defaults.generatorAgent}"`,
					),
				},
				agentConfig: {
					name: "Generator (dev-pod source, contract-driven)",
					modelSpec: "claude-opus-4-8",
					effort: "ultracode",
					instructions: PLANNER_GENERATOR_INSTRUCTIONS,
				},
				body: {
					prompt: generatePrompt(),
					overrides: {
						cwd: "/sandbox/scratch",
						maxTurns: 30,
						timeoutMinutes: 25,
					},
				},
			},
		},
	};
}

function snapshotNode(): Json {
	return {
		snapshot: {
			call: "dev/preview-snapshot",
			with: {
				executionId: jqExpr(".runtime.executionId"),
				nodeId: "generate",
				iteration: jqExpr(".idx"),
				services: ["workflow-builder"],
			},
			allowFailure: true,
		},
	};
}

function critiqueNode(cfg: GanFixtureConfig): Json {
	return {
		critique: {
			call: "durable/run",
			with: {
				cwd: "/sandbox/scratch",
				mode: "execute_direct",
				workspaceRef: jqExpr(".runtime.workspaceExecutionId"),
				agentRef: {
					slug: jqExpr(
						`.trigger.criticAgent // "${cfg.defaults.criticAgent}"`,
					),
				},
				agentConfig: {
					name: "Skeptical visual+functional critic (Playwright, contract-graded)",
					instructions: CRITIC_INSTRUCTIONS,
				},
				body: {
					prompt: critiquePrompt(),
					overrides: {
						cwd: "/sandbox/scratch",
						maxTurns: 24,
						timeoutMinutes: 25,
					},
				},
			},
			parseJson: true,
		},
	};
}

function refineNode(cfg: GanFixtureConfig): Json {
	return {
		refine: {
			for: {
				each: "i",
				in: jqExpr(
					`[range(0; ((.trigger.maxIterations // ${cfg.defaults.maxIterations}) | tonumber? // ${cfg.defaults.maxIterations}))]`,
				),
				at: "idx",
			},
			while: buildWhile(),
			do: [
				generateNode(cfg),
				buildGateNode(cfg),
				snapshotNode(),
				critiqueNode(cfg),
				buildReadVerdictNode(cfg),
			],
		},
	};
}

function summaryNode(cfg: GanFixtureConfig): Json {
	return {
		summary: {
			set: buildSummarySet(cfg),
			artifacts: [
				{
					from: jqExpr(".data"),
					kind: "json",
					slot: "primary",
					title: "GAN UI-feature result",
					description:
						"Accepted flag, iteration count, evaluation routes, output mode, final generator summary, the critic's last verdict, and the dev/preview-promote PR result.",
				},
			],
		},
	};
}

export function generateGanFixture(cfg: GanFixtureConfig): Json {
	return {
		document: {
			dsl: "1.0.0",
			namespace: cfg.namespace,
			name: cfg.name,
			version: cfg.version,
			title: cfg.title,
			summary: cfg.summary,
			"x-workflow-builder": {
				resumable: true,
				input: inputSchema(cfg),
			},
		},
		input: inputSchema(cfg),
		output: { as: jqExpr(".summary") },
		do: [
			enterDevModeNode(cfg),
			planNode(cfg),
			designReviewNode(cfg),
			refineNode(cfg),
			buildPromoteNode(cfg),
			summaryNode(cfg),
		],
	};
}

/** Stable 2-space JSON with a trailing newline (the checked-in fixture form). */
export function renderGanFixture(cfg: GanFixtureConfig): string {
	return `${JSON.stringify(generateGanFixture(cfg), null, 2)}\n`;
}
