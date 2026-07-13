import { describe, expect, it, vi } from "vitest";
import {
  buildPreviewHeadlampEgressService,
  buildPreviewHeadlampSecret,
  KubernetesPreviewHeadlampRegistrationAdapter,
} from "$lib/server/application/adapters/preview-headlamp-registration";
import { PreviewHeadlampRegistrationError } from "$lib/server/application/ports";

const UID = "11111111-2222-3333-4444-555555555555";
const caData = Buffer.from(
  "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n",
).toString("base64");
const command = {
  identity: {
    previewName: "feature-one",
    environmentRequestId: "request-1",
    environmentPlatformRevision: "a".repeat(40),
    environmentSourceRevision: "b".repeat(40),
    catalogDigest: `sha256:${"c".repeat(64)}` as const,
  },
  credential: {
    bearerToken: `eyJ.${"a".repeat(32)}.signature`,
    caData,
    serverName: "feature-one.vcluster-feature-one",
  },
};

const environment = {
  apiVersion: "preview.stacks.io/v1alpha1",
  kind: "PreviewEnvironment",
  metadata: {
    name: "feature-one",
    namespace: "preview-system",
    uid: UID,
    resourceVersion: "10",
    finalizers: ["preview.stacks.io/headlamp-registration"],
    annotations: {
      "preview.stacks.io/request-id": "request-1",
      "preview.stacks.io/platform-revision": "a".repeat(40),
      "preview.stacks.io/source-revision": "b".repeat(40),
      "preview.stacks.io/catalog-digest": `sha256:${"c".repeat(64)}`,
    },
  },
  spec: {
    id: "feature-one",
    platformRevision: "a".repeat(40),
    sourceRevision: "b".repeat(40),
    catalogDigest: `sha256:${"c".repeat(64)}`,
    provenance: { requestId: "request-1" },
  },
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("KubernetesPreviewHeadlampRegistrationAdapter", () => {
  it("derives and creates the exact UID-owned hub resources", async () => {
    const fetchImpl = vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (path.includes("previewenvironments/feature-one")) {
        return response(environment);
      }
      if (method === "GET") return response({}, 404);
      return response(JSON.parse(String(init.body)), 201);
    });
    const adapter = new KubernetesPreviewHeadlampRegistrationAdapter({
      fetch: fetchImpl,
    });

    await expect(adapter.register(command)).resolves.toEqual({
      previewName: "feature-one",
      contextName: "preview-feature-one",
      environmentUid: UID,
      secretName: "headlamp-preview-feature-one",
      serviceName: "kube-feature-one-api-egress",
    });

    const writes = fetchImpl.mock.calls
      .filter(([, init]) => (init?.method ?? "GET") === "POST")
      .map(([path, init]) => [path, JSON.parse(String(init?.body))] as const);
    expect(writes).toHaveLength(2);
    expect(writes[0]?.[0]).toBe("/api/v1/namespaces/tailscale/services");
    expect(writes[0]?.[1]).toEqual(
      buildPreviewHeadlampEgressService(command, UID),
    );
    expect(writes[1]?.[0]).toBe("/api/v1/namespaces/preview-headlamp/secrets");
    expect(writes[1]?.[1]).toEqual(buildPreviewHeadlampSecret(command, UID));

    const secret = writes[1]?.[1] as ReturnType<
      typeof buildPreviewHeadlampSecret
    >;
    const data = secret.data as Record<string, string>;
    expect(Object.keys(data).sort()).toEqual(["config", "name", "server"]);
    expect(Buffer.from(data.name, "base64").toString()).toBe(
      "preview-feature-one",
    );
    expect(Buffer.from(data.server, "base64").toString()).toBe(
      "https://kube-feature-one-api-egress.tailscale.svc.cluster.local:443",
    );
    expect(JSON.parse(Buffer.from(data.config, "base64").toString())).toEqual({
      bearerToken: command.credential.bearerToken,
      tlsClientConfig: {
        insecure: false,
        caData,
        serverName: "feature-one.vcluster-feature-one",
      },
    });
  });

  it("updates only a resource already fenced to the current environment UID", async () => {
    const service = buildPreviewHeadlampEgressService(command, UID);
    const secret = buildPreviewHeadlampSecret(command, UID);
    const existingService = {
      ...service,
      metadata: {
        ...(service.metadata as Record<string, unknown>),
        uid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        resourceVersion: "21",
        finalizers: ["tailscale.com/finalizer"],
      },
      spec: {
        ...(service.spec as Record<string, unknown>),
        externalName: "ts-feature-one-abc.tailscale.svc.cluster.local",
      },
    };
    const existingSecret = {
      ...secret,
      metadata: {
        ...(secret.metadata as Record<string, unknown>),
        uid: "ffffffff-1111-2222-3333-444444444444",
        resourceVersion: "31",
      },
    };
    const fetchImpl = vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (path.includes("previewenvironments/feature-one")) {
        return response(environment);
      }
      if (method === "GET" && path.includes("/services/")) {
        return response(existingService);
      }
      if (method === "GET" && path.includes("/secrets/")) {
        return response(existingSecret);
      }
      return response(JSON.parse(String(init.body)));
    });
    const adapter = new KubernetesPreviewHeadlampRegistrationAdapter({
      fetch: fetchImpl,
    });

    await adapter.register(command);

    const updates = fetchImpl.mock.calls.filter(
      ([, init]) => init?.method === "PUT",
    );
    expect(updates).toHaveLength(2);
    const serviceUpdate = JSON.parse(String(updates[0]?.[1]?.body));
    expect(serviceUpdate.metadata).toMatchObject({
      resourceVersion: "21",
      finalizers: ["tailscale.com/finalizer"],
      labels: {
        "preview.stacks.io/managed": "true",
        "preview.stacks.io/preview-name": "feature-one",
        "preview.stacks.io/headlamp-record": "true",
      },
      annotations: {
        "preview.stacks.io/preview-environment-uid": UID,
        "tailscale.com/tailnet-fqdn":
          "kube-feature-one.tail286401.ts.net",
      },
    });
    expect(serviceUpdate.spec.externalName).toBe("invalid.tailnet.internal");
    expect(JSON.parse(String(updates[1]?.[1]?.body)).metadata.resourceVersion).toBe(
      "31",
    );
  });

  it("rejects a stale immutable tuple before writing", async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        ...environment,
        spec: { ...environment.spec, sourceRevision: "d".repeat(40) },
      }),
    );
    const adapter = new KubernetesPreviewHeadlampRegistrationAdapter({
      fetch: fetchImpl,
    });

    await expect(adapter.register(command)).rejects.toMatchObject({
      code: "generation-mismatch",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("requires the cleanup finalizer before writing either resource", async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        ...environment,
        metadata: { ...environment.metadata, finalizers: [] },
      }),
    );
    const adapter = new KubernetesPreviewHeadlampRegistrationAdapter({
      fetch: fetchImpl,
    });

    await expect(adapter.register(command)).rejects.toMatchObject({
      code: "generation-mismatch",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses to take over a same-name resource from another UID", async () => {
    const service = buildPreviewHeadlampEgressService(command, UID);
    const fetchImpl = vi.fn(async (path: string, init: RequestInit = {}) => {
      if (path.includes("previewenvironments/feature-one")) {
        return response(environment);
      }
      if ((init.method ?? "GET") === "GET" && path.includes("/services/")) {
        return response({
          ...service,
          metadata: {
            ...(service.metadata as Record<string, unknown>),
            resourceVersion: "20",
            annotations: {
              "preview.stacks.io/preview-environment-uid":
                "99999999-8888-7777-6666-555555555555",
              "tailscale.com/tailnet-fqdn":
                "kube-feature-one.tail286401.ts.net",
            },
          },
        });
      }
      return response({}, 404);
    });
    const adapter = new KubernetesPreviewHeadlampRegistrationAdapter({
      fetch: fetchImpl,
    });

    await expect(adapter.register(command)).rejects.toBeInstanceOf(
      PreviewHeadlampRegistrationError,
    );
    await expect(adapter.register(command)).rejects.toMatchObject({
      code: "resource-ownership",
    });
    expect(
      fetchImpl.mock.calls.some(([, init]) =>
        ["POST", "PUT"].includes(String(init?.method)),
      ),
    ).toBe(false);
  });
});
