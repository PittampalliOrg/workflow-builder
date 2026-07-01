import { describe, expect, it } from "vitest";

import { buildFreightJourney, freightArtifactLabel } from "./freight-journey";
import type {
	PipelineFreight,
	PipelineModel,
	PipelineStage,
	StagePromotion,
} from "./pipeline-types";
import type { EnvName } from "./service-matrix";

describe("buildFreightJourney", () => {
	it("walks the current freight across envs: deployed → promoting → dormant", () => {
		const model = journeyModel();
		const rows = buildFreightJourney(freightOf(model, "f-new"), model);

		expect(rows.map((r) => r.env)).toEqual(["dev", "staging", "ryzen"]);
		expect(rows[0].state).toBe("promoting");
		expect(rows[0].detail).toContain("→ def5678");
		expect(rows[0].detail).toContain("soak 4m of 10m");
		expect(rows[1].state).toBe("dormant");
		expect(rows[2].state).toBe("deployed");
		expect(rows[2].detail).toBe("Healthy");
		expect(rows[2].at).toBe("2026-06-10T12:00:00Z");
	});

	it("marks stages running a newer freight as superseded, with what they run", () => {
		const model = journeyModel();
		const rows = buildFreightJourney(freightOf(model, "f-old"), model);

		expect(rows[0].state).toBe("deployed"); // dev still runs f-old
		expect(rows[2].state).toBe("superseded"); // ryzen runs f-new
		expect(rows[2].detail).toBe("running git-abc1234");
	});

	it("marks stages running an older freight as queued for the newer freight", () => {
		// No in-flight promotion → the dev stage holding the older freight reads
		// as "queued" from the new freight's perspective.
		const model = journeyModel({ devPromotion: null });
		const rows = buildFreightJourney(freightOf(model, "f-new"), model);

		expect(rows[0].state).toBe("queued");
		expect(rows[0].detail).toBe("running git-old9999");
	});

	it("does not show promoting for a non-current freight even when a promotion is in flight", () => {
		const model = journeyModel();
		const rows = buildFreightJourney(freightOf(model, "f-old"), model);
		expect(rows.map((r) => r.state)).not.toContain("promoting");
	});

	it("falls back to unknown when the stage holds no known freight", () => {
		const model = journeyModel({ devPromotion: null });
		// Strip every freight's claim on the dev stage.
		model.freights = model.freights.map((f) => ({
			...f,
			inStages: f.inStages.filter((s) => s !== "workflow-builder::dev"),
		}));
		const rows = buildFreightJourney(freightOf(model, "f-new"), model);
		expect(rows[0].state).toBe("unknown");
	});
});

describe("freightArtifactLabel", () => {
	it("prefers the image tag, falls back to the git sha", () => {
		const model = journeyModel();
		expect(freightArtifactLabel(freightOf(model, "f-new"))).toBe("git-abc1234");
		const gitOnly: PipelineFreight = {
			...freightOf(model, "f-new"),
			artifacts: [{ kind: "git", repoURL: "r", sha: "deadbeefcafe" }],
		};
		expect(freightArtifactLabel(gitOnly)).toBe("deadbeef");
	});
});

function freightOf(model: PipelineModel, id: string): PipelineFreight {
	const freight = model.freights.find((f) => f.id === id);
	if (!freight) throw new Error(`fixture freight ${id} missing`);
	return freight;
}

const IN_FLIGHT_PROMOTION: StagePromotion = {
	inFlight: true,
	proposedTag: "def5678abcdef",
	activeTag: "aaa1111",
	activeAt: "2026-06-10T11:00:00Z",
	gates: [],
	soak: { elapsed: "4m", total: "10m", label: "4m of 10m" },
	pullRequest: null,
	stalledOn: null,
};

function journeyModel(
	options: { devPromotion?: StagePromotion | null } = {},
): PipelineModel {
	const devPromotion =
		options.devPromotion === undefined ? IN_FLIGHT_PROMOTION : options.devPromotion;
	const stages = [
		stage("ryzen", { deliveryMode: "direct-main" }),
		stage("dev", { deliveryMode: "promoter", promotion: devPromotion }),
		stage("staging", { deliveryMode: "dormant", dormant: true }),
	];
	const freights: PipelineFreight[] = [
		{
			id: "f-new",
			warehouse: "workflow-builder",
			alias: "git-abc1234",
			artifacts: [
				{ kind: "image", repoURL: "ghcr.io/x/workflow-builder", tag: "git-abc1234", digest: null },
			],
			createdAt: "2026-06-10T11:30:00Z",
			inStages: ["workflow-builder::ryzen"],
			current: true,
		},
		{
			id: "f-old",
			warehouse: "workflow-builder",
			alias: "git-old9999",
			artifacts: [
				{ kind: "image", repoURL: "ghcr.io/x/workflow-builder", tag: "git-old9999", digest: null },
			],
			createdAt: "2026-06-09T11:30:00Z",
			inStages: ["workflow-builder::dev"],
			current: false,
		},
	];
	return {
		generatedAt: "2026-06-10T12:00:00Z",
		warehouseColorMap: { "workflow-builder": "#222222" },
		stageColorMap: {},
		subsystems: ["Core platform"],
		warehousesBySubsystem: {},
		freights,
		warehouses: [
			{
				name: "workflow-builder",
				kind: "service",
				subsystem: "Core platform",
				subscriptions: [],
				reconciling: false,
				hasError: false,
				specialCase: null,
			},
		],
		stages,
	};
}

function stage(
	env: EnvName,
	overrides: Partial<PipelineStage> = {},
): PipelineStage {
	return {
		name: `workflow-builder::${env}`,
		warehouse: "workflow-builder",
		env,
		requestedFreight: [],
		health: "Healthy",
		syncStatus: "Synced",
		promotionPhase: null,
		drift: null,
		desiredTag: "git-abc1234",
		liveTag: "git-abc1234",
		commitSha: "abc1234",
		source: "inventory",
		updatedAt: "2026-06-10T12:00:00Z",
		controlFlow: false,
		dormant: false,
		deliveryMode: "promoter",
		awaitingReconcile: false,
		promotion: null,
		...overrides,
	};
}
