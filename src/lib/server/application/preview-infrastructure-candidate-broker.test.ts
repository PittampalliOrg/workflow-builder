import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewInfrastructureCandidateBrokerService } from "$lib/server/application/preview-infrastructure-candidate-broker";
import type {
  PreviewControlAdminAuthorizationPort,
  PreviewControlPullRequestInspectionPort,
  PreviewEnvironmentCandidatePathRoutingPort,
  PreviewInfrastructureCandidateLaunchPort,
} from "$lib/server/application/ports";

const BASE_SHA = "a".repeat(40) as never;
const HEAD_SHA = "b".repeat(40) as never;

function harness(
  profile: "manifest-candidate" | "host-candidate" = "manifest-candidate",
  lane: "application" | "management" = "application",
) {
  const admins: PreviewControlAdminAuthorizationPort = {
    isPlatformAdmin: vi.fn(async () => true),
  };
  const pullRequests: PreviewControlPullRequestInspectionPort = {
    inspect: vi.fn(),
    inspectOpen: vi.fn(async (input) => ({
      repository: input.repository,
      number: input.number,
      baseSha: BASE_SHA,
      headRef: "infra/preview-change",
      headSha: HEAD_SHA,
      changedPaths: [
        "packages/components/workloads/workflow-builder/manifests/deployment.yaml",
      ],
    })),
  };
  const paths: PreviewEnvironmentCandidatePathRoutingPort = {
    routeCandidatePaths: vi.fn((changedPaths) => ({
      profile,
      lane,
      paths: changedPaths,
    })),
  };
  const environments: PreviewInfrastructureCandidateLaunchPort = {
    launch: vi.fn(async () => ({
      ok: true as const,
      environment: { id: "candidate-1" } as never,
    })),
  };
  return {
    admins,
    pullRequests,
    paths,
    environments,
    service: new ApplicationPreviewInfrastructureCandidateBrokerService({
      admins,
      pullRequests,
      paths,
      environments,
      platformRepository: "PittampalliOrg/stacks",
      sourceRef: "main",
    }),
  };
}

const input = {
  requestId: "request-1",
  name: "infra-pr-42",
  userId: "admin-1",
  pullRequestNumber: 42,
  ttlHours: 12,
  lifecycle: "retained" as const,
};

describe("ApplicationPreviewInfrastructureCandidateBrokerService", () => {
  it("binds a manifest launch to the verified PR head and full changed paths", async () => {
    const h = harness();

    await expect(h.service.launch(input)).resolves.toMatchObject({
      ok: true,
      status: "launched",
      profile: "manifest-candidate",
      lane: "application",
      pullRequest: { number: 42, headSha: HEAD_SHA },
    });
    expect(h.pullRequests.inspectOpen).toHaveBeenCalledWith({
      repository: "PittampalliOrg/stacks",
      number: 42,
    });
    expect(h.environments.launch).toHaveBeenCalledWith({
      name: "infra-pr-42",
      userId: "admin-1",
      profile: "manifest-candidate",
      lane: "application",
      platformRevision: HEAD_SHA,
      sourceRef: "main",
      capabilities: ["namespaced-manifests"],
      candidatePaths: [
        "packages/components/workloads/workflow-builder/manifests/deployment.yaml",
      ],
      ttlHours: 12,
      lifecycle: "retained",
      parentEnvironmentId: `pull-request:PittampalliOrg/stacks#42@${HEAD_SHA}`,
    });
  });

  it.each([
    ["manifest-candidate", "management", "preview-management-candidate.sh"],
    ["host-candidate", "application", "preview-host-candidate.sh"],
  ] as const)(
    "routes %s/%s to an operator-controlled physical lease",
    async (profile, lane, command) => {
      const h = harness(profile, lane);

      await expect(h.service.launch(input)).resolves.toMatchObject({
        ok: false,
        status: "operator-required",
        profile,
        lane,
        launch: null,
        operatorAction: {
          command,
          id: "infra-pr-42",
          revision: HEAD_SHA,
          candidatePaths: [
            "packages/components/workloads/workflow-builder/manifests/deployment.yaml",
          ],
        },
      });
      expect(h.environments.launch).not.toHaveBeenCalled();
    },
  );

  it("rejects a mixed or unmapped PR before any cluster launch", async () => {
    const h = harness();
    vi.mocked(h.paths.routeCandidatePaths).mockImplementationOnce(() => {
      throw new Error("candidate PR spans multiple preview profiles");
    });

    await expect(h.service.launch(input)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(h.environments.launch).not.toHaveBeenCalled();
  });

  it("requires central platform-admin authority", async () => {
    const h = harness();
    vi.mocked(h.admins.isPlatformAdmin).mockResolvedValueOnce(false);

    await expect(h.service.launch(input)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(h.pullRequests.inspectOpen).not.toHaveBeenCalled();
  });
});
