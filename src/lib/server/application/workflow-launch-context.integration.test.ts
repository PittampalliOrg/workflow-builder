import { describe, expect, it } from "vitest";
import { ApplicationPreviewDeploymentScopeService } from "$lib/server/application/preview-deployment-scope";
import { ApplicationWorkflowLaunchPolicyService } from "$lib/server/application/workflow-launch-policy";

const revision = "a".repeat(40);
const devWorkflow = {
  name: "Preview development",
  spec: {
    engine: "dynamic-script",
    meta: { launch: { surface: "dev-environment" } },
  },
};
const genericWorkflow = {
  name: "Generic workflow",
  spec: {
    engine: "dynamic-script",
    meta: { name: "Generic workflow" },
  },
};

function previewPolicy() {
  return new ApplicationWorkflowLaunchPolicyService(
    new ApplicationPreviewDeploymentScopeService({
      name: "preview-one",
      profile: "app-live",
      platformRevision: "b".repeat(40),
      sourceRevision: revision,
      origin: "https://wfb-preview-one.tail286401.ts.net",
    }),
  );
}

describe("trusted internal workflow launch context", () => {
  it("derives and enforces preview-native context from deployment identity", () => {
    const policy = previewPolicy();
    const context = policy.trustedInternalStartContext();

    expect(context).toEqual({
      launchSurface: "dev-environment",
      launchOrigin: "https://wfb-preview-one.tail286401.ts.net",
    });
    expect(
      policy.prepare({
        workflow: devWorkflow,
        triggerData: {
          mode: "host-throwaway",
          previewOrigin: "https://wfb-forged.other-tailnet.ts.net",
          sourceRevision: "f".repeat(40),
        },
        ...(context ?? {}),
      }),
    ).toEqual({
      ok: true,
      triggerData: {
        mode: "preview-native",
        previewOrigin: "https://wfb-preview-one.tail286401.ts.net",
        sourceRevision: revision,
      },
    });
  });

  it("does not turn control-plane internal starts into target-aware launches", () => {
    const policy = new ApplicationWorkflowLaunchPolicyService(
      new ApplicationPreviewDeploymentScopeService(null),
    );
    const context = policy.trustedInternalStartContext();

    expect(context).toBeNull();
    expect(
      policy.prepare({
        workflow: devWorkflow,
        triggerData: {},
        ...(context ?? {}),
      }),
    ).toMatchObject({ ok: false, status: 409 });
  });

  it("leaves generic workflows unchanged in both deployment modes", () => {
    const preview = previewPolicy();
    const controlPlane = new ApplicationWorkflowLaunchPolicyService(
      new ApplicationPreviewDeploymentScopeService(null),
    );
    const triggerData = { message: "hello" };

    for (const policy of [preview, controlPlane]) {
      const context = policy.trustedInternalStartContext();
      expect(
        policy.prepare({
          workflow: genericWorkflow,
          triggerData,
          ...(context ?? {}),
        }),
      ).toEqual({ ok: true, triggerData });
    }
  });

  it("fails closed when deployment origin does not match preview identity", () => {
    const policy = new ApplicationWorkflowLaunchPolicyService(
      new ApplicationPreviewDeploymentScopeService({
        name: "preview-one",
        profile: "app-live",
        platformRevision: "b".repeat(40),
        sourceRevision: revision,
        origin: "https://wfb-preview-two.tail286401.ts.net",
      }),
    );

    expect(policy.trustedInternalStartContext()).toBeNull();
    expect(
      policy.prepare({
        workflow: devWorkflow,
        triggerData: {},
      }),
    ).toMatchObject({ ok: false, status: 409 });
  });
});
