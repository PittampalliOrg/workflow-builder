import { describe, expect, it } from "vitest";
import { ApplicationPreviewDeploymentScopeService } from "$lib/server/application/preview-deployment-scope";

const preview = {
  name: "feature-one",
  profile: "app-live",
  platformRevision: "a".repeat(40),
  sourceRevision: "b".repeat(40),
  origin: "interactive-session",
};

describe("preview deployment scope", () => {
  it("keeps fleet authority on the canonical control-plane deployment", () => {
    const scope = new ApplicationPreviewDeploymentScopeService(null);

    expect(scope.current()).toEqual({ kind: "control-plane" });
    expect(scope.isControlPlane()).toBe(true);
    expect(scope.allowsPreviewName("feature-one")).toBe(true);
    expect(scope.allowsPreviewName("feature-two")).toBe(true);
  });

  it("limits a preview deployment to its exact canonical name", () => {
    const scope = new ApplicationPreviewDeploymentScopeService(preview);

    expect(scope.current()).toEqual({ kind: "preview", preview });
    expect(scope.isControlPlane()).toBe(false);
    expect(scope.allowsPreviewName("feature-one")).toBe(true);
    expect(scope.allowsPreviewName("feature-two")).toBe(false);
    expect(scope.allowsPreviewName("Feature-One")).toBe(false);
  });

  it("fails closed on a non-canonical deployment identity", () => {
    expect(
      () =>
        new ApplicationPreviewDeploymentScopeService({
          ...preview,
          name: "Feature One",
        }),
    ).toThrow("preview deployment identity must be a canonical preview name");
  });
});
