import { describe, expect, it } from "vitest";
import { normalizeDrasiObservation } from "./drasi-observations";

const observation = {
  resourceRef: {
    group: "dapr.io",
    version: "v1alpha1",
    resource: "components",
    kind: "Component",
    namespace: "workflow-builder",
    name: "workflowstatestore",
    uid: "uid-1",
  },
  phase: "Drifted",
  reason: "WorkflowStateStoreInvariant",
  message: "actor store invariant failed",
  observedAt: "2026-07-21T12:00:00Z",
  correlation: { cluster: "dev", resourceVersion: "123" },
};

describe("normalizeDrasiObservation", () => {
  it("projects only allowlisted scalar resource state", () => {
    const result = normalizeDrasiObservation(observation);
    expect(result).toEqual({
      ok: true,
      event: expect.objectContaining({
        source: "drasi-kubernetes-observer",
        activityType: "kubernetes.resource",
        raw: {},
        observedAt: "2026-07-21T12:00:00.000Z",
      }),
      currentEvent: expect.objectContaining({
        source: "drasi-kubernetes-observer-current",
        raw: {},
      }),
    });
  });

  it("rejects secret-bearing raw objects and unobserved resource types", () => {
    expect(
      normalizeDrasiObservation({ ...observation, raw: { token: "secret" } }),
    ).toEqual({ ok: false, error: "raw is not allowed" });
    expect(
      normalizeDrasiObservation({
        ...observation,
        resourceRef: {
          ...observation.resourceRef,
          group: "",
          resource: "secrets",
          kind: "Secret",
        },
      }),
    ).toEqual({ ok: false, error: "resourceRef type is not allowlisted" });
  });

  it("redacts credential-shaped text", () => {
    const result = normalizeDrasiObservation({
      ...observation,
      message: "Authorization: Bearer abc.def password=hunter2",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.message).not.toContain("abc.def");
      expect(result.event.message).not.toContain("hunter2");
    }
  });

  it("accepts deletion tombstones without accepting a raw resource body", () => {
    const result = normalizeDrasiObservation({
      ...observation,
      phase: "Deleted",
      reason: "ResourceDeleted",
      message: "Resource no longer returned by the Kubernetes API",
    });
    expect(result).toEqual({
      ok: true,
      event: expect.objectContaining({
        phase: "Deleted",
        raw: {},
      }),
      currentEvent: expect.objectContaining({ phase: "Deleted", raw: {} }),
    });
  });

  it("deduplicates exact redelivery but preserves distinct transitions", () => {
    const first = normalizeDrasiObservation(observation);
    const redelivery = normalizeDrasiObservation(observation);
    const transition = normalizeDrasiObservation({
      ...observation,
      phase: "Healthy",
      reason: "Ready",
      observedAt: "2026-07-21T12:05:00Z",
      correlation: {
        ...observation.correlation,
        resourceVersion: "124",
      },
    });
    expect(redelivery).toEqual(first);
    expect(first.ok && transition.ok).toBe(true);
    if (first.ok && transition.ok) {
      expect(transition.currentEvent.eventId).toBe(first.currentEvent.eventId);
      expect(transition.event.eventId).not.toBe(first.event.eventId);
    }
  });
});
