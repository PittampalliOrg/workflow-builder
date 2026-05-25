import { afterEach, describe, expect, it, vi } from "vitest";
import {
  benchmarkLaunchControlPlaneError,
  inferArgoApplicationName,
  summarizeArgoApplicationStability,
  summarizeWorkflowBuilderDeployment,
  type BenchmarkLaunchControlPlaneStability,
} from "./launch-stability";
import type { KubeDeployment, KubePod } from "$lib/server/kube/client";

afterEach(() => {
  vi.unstubAllEnvs();
});

function readyPod(name: string, ageSeconds: number): KubePod {
  return {
    metadata: {
      name,
      labels: { app: "workflow-builder" },
      creationTimestamp: new Date(
        Date.UTC(2026, 4, 24, 12, 0, -ageSeconds),
      ).toISOString(),
    },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
    },
  };
}

function deployment(overrides: Partial<KubeDeployment> = {}): KubeDeployment {
  return {
    metadata: {
      name: "workflow-builder",
      namespace: "workflow-builder",
      generation: 3,
      ...overrides.metadata,
    },
    spec: {
      replicas: 2,
      ...overrides.spec,
    },
    status: {
      observedGeneration: 3,
      replicas: 2,
      updatedReplicas: 2,
      readyReplicas: 2,
      availableReplicas: 2,
      ...overrides.status,
    },
  };
}

describe("benchmark launch control-plane stability", () => {
  it("pauses when workflow-builder pods rolled inside the stability window", () => {
    const summary = summarizeWorkflowBuilderDeployment({
      deployment: deployment(),
      pods: [
        readyPod("workflow-builder-a", 300),
        readyPod("workflow-builder-b", 30),
      ],
      namespace: "workflow-builder",
      name: "workflow-builder",
      stableSeconds: 120,
      now: Date.UTC(2026, 4, 24, 12, 0, 0),
    });

    expect(summary.stable).toBe(false);
    expect(summary.reasons).toContain("deployment_recently_rolled");
    expect(summary.youngestReadyPodAgeSeconds).toBe(30);
  });

  it("treats fully rolled old workflow-builder pods as stable", () => {
    const summary = summarizeWorkflowBuilderDeployment({
      deployment: deployment(),
      pods: [
        readyPod("workflow-builder-a", 300),
        readyPod("workflow-builder-b", 240),
      ],
      namespace: "workflow-builder",
      name: "workflow-builder",
      stableSeconds: 120,
      now: Date.UTC(2026, 4, 24, 12, 0, 0),
    });

    expect(summary).toMatchObject({
      stable: true,
      reasons: [],
      replicas: 2,
      updatedReplicas: 2,
      readyReplicas: 2,
      availableReplicas: 2,
      youngestReadyPodAgeSeconds: 240,
    });
  });

  it("infers the dev Argo Application from the public workflow-builder URL", () => {
    vi.stubEnv(
      "APP_PUBLIC_URL",
      "https://workflow-builder-dev.tail286401.ts.net",
    );

    expect(inferArgoApplicationName()).toBe("dev-workflow-builder");
  });

  it("pauses while the managing Argo Application is running hooks or recently finished", () => {
    const summary = summarizeArgoApplicationStability({
      appName: "dev-workflow-builder",
      namespace: "argocd",
      app: {
        status: {
          sync: { status: "Synced" },
          health: { status: "Healthy" },
          operationState: {
            phase: "Running",
            startedAt: "2026-05-24T11:59:00.000Z",
          },
        },
      },
      stableSeconds: 120,
      now: Date.UTC(2026, 4, 24, 12, 0, 0),
    });

    expect(summary.stable).toBe(false);
    expect(summary.operationPhase).toBe("Running");
  });

  it("returns a launch error with the first instability reason", () => {
    const stability: BenchmarkLaunchControlPlaneStability = {
      stable: false,
      reasons: ["deployment_recently_rolled", "argocd_application_not_stable"],
      stableSeconds: 120,
      deployment: {
        name: "workflow-builder",
        namespace: "workflow-builder",
        stable: false,
        reasons: ["deployment_recently_rolled"],
        replicas: 2,
        updatedReplicas: 2,
        readyReplicas: 2,
        availableReplicas: 2,
        observedGeneration: 3,
        generation: 3,
        youngestReadyPodAgeSeconds: 30,
      },
      hookJobs: {
        stable: true,
        activeJobs: [],
        checkedNames: ["db-migrate"],
        error: null,
      },
      argoApplication: {
        configured: true,
        stable: false,
        appName: "dev-workflow-builder",
        namespace: "argocd",
        syncStatus: "Synced",
        healthStatus: "Healthy",
        operationPhase: "Running",
        operationMessage: null,
        operationStartedAt: null,
        operationFinishedAt: null,
        secondsSinceFinished: null,
        error: null,
      },
      activeSwebenchWorkflows: {
        stable: true,
        count: 0,
        sampleIds: [],
        error: null,
      },
    };

    expect(benchmarkLaunchControlPlaneError(stability)).toBe(
      "SWE-bench launch is paused while workflow-builder control plane stabilizes: deployment_recently_rolled",
    );
  });
});
