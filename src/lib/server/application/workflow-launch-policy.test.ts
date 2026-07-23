import { describe, expect, it } from "vitest";
import { ApplicationWorkflowLaunchPolicyService } from "$lib/server/application/workflow-launch-policy";
import { PREVIEW_WORKSPACE_ACTION_SLUGS } from "$lib/server/application/ports";
import type {
  PreviewDeploymentScopePort,
  PreviewLocalControlIdentityPort,
} from "$lib/server/application/ports";

const spec = {
  document: {
    "x-workflow-builder": { launch: { surface: "dev-environment" } },
  },
};
const revision = "a".repeat(40);
const hostLifecycleSpec = {
	engine: "dynamic-script",
	meta: {
		launch: { surface: "dev-environment", target: "control-plane" },
	},
};
const securePreviewSpec = {
  engine: "dynamic-script",
  meta: {
    launch: { surface: "dev-environment" },
  },
  script:
    "export const meta = { name: 'secure preview', launch: { surface: 'dev-environment' } }; return action('dev/preview-workspace-seed', { service: 'workflow-builder' });",
};

function scope(
  current: ReturnType<PreviewDeploymentScopePort["current"]>,
): PreviewDeploymentScopePort {
  return {
    current: () => current,
    isControlPlane: () => current.kind === "control-plane",
    allowsPreviewName: () => true,
  };
}

function identity(
  overrides: Partial<
    ReturnType<PreviewLocalControlIdentityPort["current"]>
  > = {},
): PreviewLocalControlIdentityPort {
  return {
    current: () => ({
      previewName: "feature-one",
      environmentRequestId: "request-1",
      environmentPlatformRevision: "b".repeat(40),
      environmentSourceRevision: revision,
      catalogDigest: `sha256:${"c".repeat(64)}`,
      ...overrides,
    }),
  };
}

describe("ApplicationWorkflowLaunchPolicyService", () => {
	it("rejects unsupported preview actions in SW and dynamic-script specs before launch", () => {
		const deployment = scope({
			kind: "preview",
			preview: {
				name: "feature-one",
				profile: "app-live",
				platformRevision: null,
				sourceRevision: revision,
				origin: "https://workflow-builder-ryzen.tail286401.ts.net",
			},
		});
		const capabilities = {
			actionAvailability: (slug: string) => ({
				available: slug !== "browser/start-preview",
				code: slug === "browser/start-preview" ? "unsupported_in_preview" : "available",
				message:
					slug === "browser/start-preview"
						? "browser/start-preview is unavailable in preview deployments"
						: null,
			}),
		};
		const service = new ApplicationWorkflowLaunchPolicyService(
			deployment,
			capabilities,
		);

		for (const unsupportedSpec of [
			{ do: [{ preview: { call: "browser/start-preview", with: {} } }] },
			{
				engine: "dynamic-script",
				meta: { name: "preview" },
				script:
					"export const meta = { name: 'preview' }; export default async function run() { return action('browser/start-preview', {}); }",
			},
		]) {
			expect(
				service.prepare({
					workflow: { name: "preview", spec: unsupportedSpec },
					triggerData: {},
				}),
			).toEqual({
				ok: false,
				status: 409,
				error:
					"unsupported_in_preview: browser/start-preview is unavailable in preview deployments",
			});
		}
	});

  it("rejects context-launched workflows submitted through generic Execute", () => {
    const service = new ApplicationWorkflowLaunchPolicyService(
      scope({ kind: "control-plane" }),
    );

    expect(
      service.prepare({ workflow: { name: "dev", spec }, triggerData: {} }),
    ).toEqual({
      ok: false,
      status: 409,
      error:
        "This workflow requires the target-aware Dev launcher. Open the workspace Dev page and start the session there.",
    });
  });

  it("binds preview-native launch data to the current app-live preview", () => {
    const service = new ApplicationWorkflowLaunchPolicyService(
      scope({
        kind: "preview",
        preview: {
          name: "feature-one",
          profile: "app-live",
          platformRevision: "b".repeat(40),
          sourceRevision: revision,
          origin: "https://workflow-builder-ryzen.tail286401.ts.net",
        },
      }),
    );

    expect(
      service.prepare({
        workflow: { name: "dev", spec },
        launchSurface: "dev-environment",
        launchOrigin: "https://wfb-feature-one.tail286401.ts.net",
        triggerData: {
          mode: "preview-native",
          previewOrigin: "https://wfb-feature-one.tail286401.ts.net/",
          sourceRevision: revision,
        },
      }),
    ).toEqual({
      ok: true,
      triggerData: {
        mode: "preview-native",
        previewOrigin: "https://wfb-feature-one.tail286401.ts.net",
        sourceRevision: revision,
      },
    });
  });

  it("replaces caller-supplied preview targeting with trusted deployment context", () => {
    const service = new ApplicationWorkflowLaunchPolicyService(
      scope({
        kind: "preview",
        preview: {
          name: "feature-one",
          profile: "app-live",
          platformRevision: null,
          sourceRevision: revision,
          origin: "https://workflow-builder-ryzen.tail286401.ts.net",
        },
      }),
    );

    expect(
      service.prepare({
        workflow: { name: "dev", spec },
        launchSurface: "dev-environment",
        launchOrigin: "https://wfb-feature-one.tail286401.ts.net",
        triggerData: {
          mode: "host-throwaway",
          previewOrigin: "https://wfb-other.tail286401.ts.net",
          sourceRevision: "b".repeat(40),
        },
      }),
    ).toEqual({
      ok: true,
      triggerData: {
        mode: "preview-native",
        previewOrigin: "https://wfb-feature-one.tail286401.ts.net",
        sourceRevision: revision,
      },
    });
  });

  it("returns immutable execution authority for secure preview workspace actions", () => {
    const forgedContext = {
      target: {
        previewName: "forged",
        environmentRequestId: "forged",
      },
    };
    const service = new ApplicationWorkflowLaunchPolicyService(
      scope({
        kind: "preview",
        preview: {
          name: "feature-one",
          profile: "app-live",
          platformRevision: "b".repeat(40),
          sourceRevision: revision,
          origin: "https://workflow-builder-ryzen.tail286401.ts.net",
        },
      }),
      undefined,
      identity(),
    );

    expect(
      service.prepare({
        workflow: { name: "secure", spec: securePreviewSpec },
        launchSurface: "dev-environment",
        launchOrigin: "https://wfb-feature-one.tail286401.ts.net",
        triggerData: {
          intent: "change",
          __previewDevelopment: forgedContext,
        },
      }),
    ).toEqual({
      ok: true,
      triggerData: {
        intent: "change",
        __previewDevelopment: forgedContext,
        mode: "preview-native",
        previewOrigin: "https://wfb-feature-one.tail286401.ts.net",
        sourceRevision: revision,
      },
      previewWorkspaceBinding: {
        version: 1,
        target: {
          previewName: "feature-one",
          environmentRequestId: "request-1",
          platformRevision: "b".repeat(40),
          sourceRevision: revision,
          catalogDigest: `sha256:${"c".repeat(64)}`,
        },
      },
    });
  });

  it("fails closed when secure action authority cannot be derived locally", () => {
    const deployment = scope({
      kind: "preview",
      preview: {
        name: "feature-one",
        profile: "app-live",
        platformRevision: "b".repeat(40),
        sourceRevision: revision,
        origin: "https://workflow-builder-ryzen.tail286401.ts.net",
      },
    });
    const missing = new ApplicationWorkflowLaunchPolicyService(deployment);
    const stale = new ApplicationWorkflowLaunchPolicyService(
      deployment,
      undefined,
      identity({ environmentSourceRevision: "d".repeat(40) }),
    );
    const stalePlatform = new ApplicationWorkflowLaunchPolicyService(
      deployment,
      undefined,
      identity({ environmentPlatformRevision: "e".repeat(40) }),
    );

    for (const service of [missing, stale, stalePlatform]) {
      expect(
        service.prepare({
          workflow: { name: "secure", spec: securePreviewSpec },
          launchSurface: "dev-environment",
          launchOrigin: "https://wfb-feature-one.tail286401.ts.net",
          triggerData: {},
        }),
      ).toMatchObject({ ok: false, status: 409 });
    }
  });

  it("requires an exact platform revision before deriving workspace authority", () => {
    const service = new ApplicationWorkflowLaunchPolicyService(
      scope({
        kind: "preview",
        preview: {
          name: "feature-one",
          profile: "app-live",
          platformRevision: null,
          sourceRevision: revision,
          origin: "https://workflow-builder-ryzen.tail286401.ts.net",
        },
      }),
      undefined,
      identity(),
    );

    expect(
      service.prepare({
        workflow: { name: "secure", spec: securePreviewSpec },
        launchSurface: "dev-environment",
        launchOrigin: "https://wfb-feature-one.tail286401.ts.net",
        triggerData: {},
      }),
    ).toEqual({
      ok: false,
      status: 409,
      error: "The target preview does not expose an exact platform revision",
    });
  });

  it("keeps policy coverage aligned with every preview workspace action", () => {
    expect(PREVIEW_WORKSPACE_ACTION_SLUGS).toEqual([
      "dev/preview-workspace-seed",
      "dev/preview-workspace-sync",
      "dev/preview-sidecar-run",
    ]);
    const service = new ApplicationWorkflowLaunchPolicyService(
      scope({
        kind: "preview",
        preview: {
          name: "feature-one",
          profile: "app-live",
          platformRevision: "b".repeat(40),
          sourceRevision: revision,
          origin: "https://workflow-builder-ryzen.tail286401.ts.net",
        },
      }),
      undefined,
      identity(),
    );

    for (const slug of PREVIEW_WORKSPACE_ACTION_SLUGS) {
      expect(
        service.prepare({
          workflow: {
            name: slug,
            spec: {
              engine: "dynamic-script",
              meta: { launch: { surface: "dev-environment" } },
              script: `export const meta = { name: 'secure', launch: { surface: 'dev-environment' } }; return action('${slug}', { service: 'workflow-builder' });`,
            },
          },
          launchSurface: "dev-environment",
          launchOrigin: "https://wfb-feature-one.tail286401.ts.net",
          triggerData: {},
        }),
      ).toMatchObject({
        ok: true,
        previewWorkspaceBinding: { version: 1 },
      });
    }
  });

  it("rejects secure preview workspace actions on a generic launch", () => {
    const service = new ApplicationWorkflowLaunchPolicyService(
      scope({ kind: "control-plane" }),
    );
    const genericSecureSpec = {
      ...securePreviewSpec,
      meta: { name: "generic secure" },
      script:
        "export const meta = { name: 'generic secure' }; return action('dev/preview-workspace-seed', { service: 'workflow-builder' });",
    };

    expect(
      service.prepare({
        workflow: { name: "secure", spec: genericSecureSpec },
        triggerData: {},
      }),
    ).toMatchObject({ ok: false, status: 409 });
  });

  it("rejects a request origin on a different Tailnet", () => {
    const service = new ApplicationWorkflowLaunchPolicyService(
      scope({
        kind: "preview",
        preview: {
          name: "feature-one",
          profile: "app-live",
          platformRevision: null,
          sourceRevision: revision,
          origin: "https://workflow-builder-ryzen.tail286401.ts.net",
        },
      }),
    );

    expect(
      service.prepare({
        workflow: { name: "dev", spec },
        launchSurface: "dev-environment",
        launchOrigin: "https://wfb-feature-one.other-tailnet.ts.net",
        triggerData: {
          mode: "preview-native",
          previewOrigin: "https://wfb-feature-one.other-tailnet.ts.net",
          sourceRevision: revision,
        },
      }),
    ).toMatchObject({ ok: false, status: 409 });
  });

  it("rejects a request origin for a different preview", () => {
    const service = new ApplicationWorkflowLaunchPolicyService(
      scope({
        kind: "preview",
        preview: {
          name: "feature-one",
          profile: "app-live",
          platformRevision: null,
          sourceRevision: revision,
          origin: "https://workflow-builder-ryzen.tail286401.ts.net",
        },
      }),
    );

    expect(
      service.prepare({
        workflow: { name: "dev", spec },
        launchSurface: "dev-environment",
        launchOrigin: "https://wfb-other.tail286401.ts.net",
        triggerData: {},
      }),
    ).toMatchObject({ ok: false, status: 409 });
  });

  it("rejects a missing request origin in a preview deployment", () => {
    const service = new ApplicationWorkflowLaunchPolicyService(
      scope({
        kind: "preview",
        preview: {
          name: "feature-one",
          profile: "app-live",
          platformRevision: null,
          sourceRevision: revision,
          origin: "https://workflow-builder-ryzen.tail286401.ts.net",
        },
      }),
    );

    expect(
      service.prepare({
        workflow: { name: "dev", spec },
        launchSurface: "dev-environment",
        triggerData: {},
      }),
    ).toMatchObject({ ok: false, status: 409 });
  });

  it("derives host-throwaway mode and strips preview authority on the control plane", () => {
    const service = new ApplicationWorkflowLaunchPolicyService(
      scope({ kind: "control-plane" }),
    );

    expect(
      service.prepare({
        workflow: { name: "dev", spec },
        launchSurface: "dev-environment",
        launchOrigin: null,
        triggerData: {
          mode: "preview-native",
          service: "function-router",
          previewOrigin: "https://wfb-other.tail286401.ts.net",
          sourceRevision: revision,
        },
      }),
    ).toEqual({
      ok: true,
      triggerData: { mode: "host-throwaway", service: "function-router" },
    });
  });

	it("preserves the strict host lifecycle input without injecting child fields", () => {
		const service = new ApplicationWorkflowLaunchPolicyService(
			scope({ kind: "control-plane" }),
		);
		const triggerData = {
			intent: "Add a dashboard capability",
			environmentName: "dashboard-proof",
			services: ["workflow-builder"],
			ttlHours: 8,
			retainAfterCompletion: false,
		};

		expect(
			service.prepare({
				workflow: {
					name: "preview-development-lifecycle",
					spec: hostLifecycleSpec,
				},
				launchSurface: "dev-environment",
				launchOrigin: null,
				triggerData,
			}),
		).toEqual({ ok: true, triggerData });
	});

	it("rejects the host lifecycle inside a preview deployment", () => {
		const service = new ApplicationWorkflowLaunchPolicyService(
			scope({
				kind: "preview",
				preview: {
					name: "feature-one",
					profile: "app-live",
					platformRevision: "b".repeat(40),
					sourceRevision: revision,
					origin: "https://workflow-builder-ryzen.tail286401.ts.net",
				},
			}),
		);

		expect(
			service.prepare({
				workflow: {
					name: "preview-development-lifecycle",
					spec: hostLifecycleSpec,
				},
				launchSurface: "dev-environment",
				triggerData: { intent: "change", environmentName: "proof" },
			}),
		).toEqual({
			ok: false,
			status: 409,
			error: "This workflow can only orchestrate preview development from the control plane.",
		});
	});

  it("rejects development launches from a non-app-live preview deployment", () => {
    const service = new ApplicationWorkflowLaunchPolicyService(
      scope({
        kind: "preview",
        preview: {
          name: "feature-one",
          profile: "infrastructure",
          platformRevision: null,
          sourceRevision: revision,
          origin: "https://wfb-feature-one.tail286401.ts.net",
        },
      }),
    );

    expect(
      service.prepare({
        workflow: { name: "dev", spec },
        launchSurface: "dev-environment",
        launchOrigin: "https://wfb-feature-one.tail286401.ts.net",
        triggerData: { mode: "host-throwaway" },
      }),
    ).toMatchObject({ ok: false, status: 409 });
  });
});
