import {
	AGENT_MODEL_OPTIONS,
	canonicalAgentModelSpec,
} from "$lib/agents/model-options";
import type {
	SessionAgentConfigPatchResult,
	WorkflowDataService,
} from "$lib/server/application/ports";

export type SessionAgentConfigCommandInput = {
	sessionId: string;
	userId: string;
	projectId?: string | null;
	body: Record<string, unknown>;
};

export type SessionAgentConfigCommandResult =
	| {
			status: "ok";
			body: Record<string, unknown>;
	  }
	| {
			status: "error";
			httpStatus: number;
			message: string;
	  };

type SessionAgentConfigPatchPort = Pick<
	WorkflowDataService,
	"raiseSessionAgentConfigPatch"
>;

export class ApplicationSessionAgentConfigService {
	constructor(
		private readonly deps: {
			patches: SessionAgentConfigPatchPort;
		},
	) {}

	async setModel(
		input: SessionAgentConfigCommandInput,
	): Promise<SessionAgentConfigCommandResult> {
		const requestedModelSpec =
			typeof input.body.modelSpec === "string" ? input.body.modelSpec.trim() : "";
		if (!requestedModelSpec) {
			return {
				status: "error",
				httpStatus: 400,
				message: "modelSpec is required",
			};
		}
		const modelSpec = canonicalAgentModelSpec(requestedModelSpec);
		if (!modelSpec) {
			return {
				status: "error",
				httpStatus: 400,
				message: `Unsupported modelSpec. Allowed: ${AGENT_MODEL_OPTIONS.map((m) => m.value).join(", ")}`,
			};
		}

		const result = await this.raisePatch(input, { modelSpec });
		if (!result.ok) return patchError(result, "set-model failed");
		return { status: "ok", body: { modelSpec } };
	}

	async setPermissionMode(
		input: SessionAgentConfigCommandInput,
	): Promise<SessionAgentConfigCommandResult> {
		const mode = input.body.mode;
		if (mode !== "bypass" && mode !== "default") {
			return {
				status: "error",
				httpStatus: 400,
				message: "mode must be 'bypass' or 'default'",
			};
		}

		const result = await this.raisePatch(input, { permissionMode: mode });
		if (!result.ok) return patchError(result, "set-permission-mode failed");
		return { status: "ok", body: { mode } };
	}

	async updateAgentConfig(
		input: SessionAgentConfigCommandInput,
	): Promise<SessionAgentConfigCommandResult> {
		const result = await this.raisePatch(input, input.body);
		if (!result.ok) return patchError(result, "update-agent-config failed");
		return {
			status: "ok",
			body: { patch: result.patch, applies: "next_turn" },
		};
	}

	private raisePatch(input: SessionAgentConfigCommandInput, patch: unknown) {
		return this.deps.patches.raiseSessionAgentConfigPatch({
			sessionId: input.sessionId,
			patch,
			projectId: input.projectId ?? null,
			userId: input.userId,
		});
	}
}

function patchError(
	result: Extract<SessionAgentConfigPatchResult, { ok: false }>,
	fallback: string,
): SessionAgentConfigCommandResult {
	return {
		status: "error",
		httpStatus: result.status,
		message: result.error ?? fallback,
	};
}
