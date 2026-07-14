import { describe, expect, it } from "vitest";
import { ApplicationWorkflowLaunchPolicyService } from "$lib/server/application/workflow-launch-policy";
import type { PreviewDeploymentScopePort } from "$lib/server/application/ports";

const spec = {
  document: {
    "x-workflow-builder": { launch: { surface: "dev-environment" } },
  },
};
const revision = "a".repeat(40);

function scope(
  current: ReturnType<PreviewDeploymentScopePort["current"]>,
): PreviewDeploymentScopePort {
  return {
    current: () => current,
    isControlPlane: () => current.kind === "control-plane",
    allowsPreviewName: () => true,
  };
}

describe("ApplicationWorkflowLaunchPolicyService", () => {
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
