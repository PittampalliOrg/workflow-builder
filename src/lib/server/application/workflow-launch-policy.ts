import type {
  PreviewDeploymentScopePort,
  TrustedWorkflowLaunchContext,
  WorkflowLaunchPolicyPort,
  WorkflowLaunchPolicyResult,
} from "$lib/server/application/ports";
import {
  canonicalPreviewOrigin,
  previewNameFromOrigin,
} from "$lib/server/application/preview-development-build";
import { getWorkflowLaunchSurface, getWorkflowLaunchTarget } from "$lib/utils/workflow-launch";
import { parseScriptStructure } from "$lib/utils/script-graph-adapter";

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

function trustedTailnetSuffix(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }

  const labels = parsed.hostname.split(".");
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    labels.length < 4 ||
    labels.at(-2) !== "ts" ||
    labels.at(-1) !== "net"
  ) {
    return null;
  }

  return labels.slice(1).join(".");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function policyError(
  status: number,
  error: string,
): WorkflowLaunchPolicyResult {
  return { ok: false, status, error };
}

/** Bind environment-aware launches to the current immutable preview scope. */
export class ApplicationWorkflowLaunchPolicyService implements WorkflowLaunchPolicyPort {
	constructor(
		private readonly scope: PreviewDeploymentScopePort,
		private readonly capabilities?: {
			actionAvailability(slug: string): {
				available: boolean;
				code: string;
				message: string | null;
			};
		},
	) {}

	trustedInternalStartContext(): TrustedWorkflowLaunchContext | null {
		const deployment = this.scope.current();
		if (deployment.kind === "control-plane") return null;

		try {
			const launchOrigin = canonicalPreviewOrigin(
				deployment.preview.origin ?? "",
			);
			if (previewNameFromOrigin(launchOrigin) !== deployment.preview.name) {
				return null;
			}
			return Object.freeze({
				launchSurface: "dev-environment",
				launchOrigin,
			});
		} catch {
			return null;
		}
	}

  prepare(
    input: Parameters<WorkflowLaunchPolicyPort["prepare"]>[0],
  ): WorkflowLaunchPolicyResult {
		for (const slug of declaredActionSlugs(input.workflow.spec)) {
			const availability = this.capabilities?.actionAvailability(slug);
			if (availability && !availability.available) {
				return policyError(
					409,
					`${availability.code}: ${availability.message ?? `${slug} is unavailable`}`,
				);
			}
		}
    const requiredSurface = getWorkflowLaunchSurface(input.workflow.spec);
    if (requiredSurface === "generic") {
      return { ok: true, triggerData: input.triggerData };
    }
    if (input.launchSurface !== requiredSurface) {
      return policyError(
        409,
        "This workflow requires the target-aware Dev launcher. Open the workspace Dev page and start the session there.",
      );
    }

    const triggerData = asRecord(input.triggerData);
    const deployment = this.scope.current();
		if (getWorkflowLaunchTarget(input.workflow.spec) === "control-plane") {
			if (deployment.kind !== "control-plane") {
				return policyError(
					409,
					"This workflow can only orchestrate preview development from the control plane.",
				);
			}
			return { ok: true, triggerData };
		}
    if (deployment.kind === "control-plane") {
      const hostTriggerData = { ...triggerData };
      delete hostTriggerData.previewOrigin;
      delete hostTriggerData.sourceRevision;
      return {
        ok: true,
        triggerData: { ...hostTriggerData, mode: "host-throwaway" },
      };
    }
    if (deployment.preview.profile !== "app-live") {
      return policyError(
        409,
        "Preview-native development sessions must be launched from inside the target app-live preview.",
      );
    }

    const expectedRevision = deployment.preview.sourceRevision?.trim() ?? "";
    if (!FULL_GIT_SHA.test(expectedRevision)) {
      return policyError(
        409,
        "The target preview does not expose an exact source revision",
      );
    }

    let expectedOrigin: string;
    try {
      const expectedTailnet = trustedTailnetSuffix(deployment.preview.origin);
      expectedOrigin = canonicalPreviewOrigin(input.launchOrigin ?? "");
      const requestHostname = new URL(expectedOrigin).hostname;
      if (previewNameFromOrigin(expectedOrigin) !== deployment.preview.name) {
        throw new Error("preview identity mismatch");
      }
      if (
        !expectedTailnet ||
        requestHostname !== `wfb-${deployment.preview.name}.${expectedTailnet}`
      ) {
        throw new Error("preview tailnet mismatch");
      }
    } catch {
      return policyError(
        409,
        "The request does not identify the target preview's trusted canonical HTTPS origin",
      );
    }

    return {
      ok: true,
      triggerData: {
        ...triggerData,
        mode: "preview-native",
        previewOrigin: expectedOrigin,
        sourceRevision: expectedRevision,
      },
    };
  }
}

function declaredActionSlugs(spec: unknown): string[] {
	const slugs = new Set<string>();
	const specRecord = asRecord(spec);
	if (specRecord.engine === "dynamic-script") {
		const script = typeof specRecord.script === "string" ? specRecord.script : "";
		if (script) {
			for (const call of parseScriptStructure(script, specRecord.meta).calls) {
				if (call.kind === "action" && call.actionSlug) {
					slugs.add(call.actionSlug);
				}
			}
		}
		return [...slugs];
	}

	const seen = new Set<object>();
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		if (seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (key === "call" && typeof child === "string" && child.includes("/")) {
				slugs.add(child.trim());
			}
			visit(child);
		}
	};
	visit(spec);
	return [...slugs];
}
