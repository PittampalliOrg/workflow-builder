import {
  validatePreviewHeadlampRegistrationCommand,
} from "$lib/server/application/preview-headlamp-registration";
import {
  PreviewHeadlampRegistrationError,
  type PreviewControlIdentity,
  type PreviewHeadlampRegistration,
  type PreviewHeadlampRegistrationCommand,
  type PreviewHeadlampRegistrationPort,
} from "$lib/server/application/ports";

type KubeFetch = (
  path: string,
  init?: RequestInit & { retries?: number },
) => Promise<Response>;

export type KubernetesPreviewHeadlampRegistrationOptions = Readonly<{
  fetch: KubeFetch;
}>;

const PREVIEW_NAMESPACE = "preview-system";
const TAILSCALE_NAMESPACE = "tailscale";
const ENVIRONMENT_UID_ANNOTATION =
  "preview.stacks.io/preview-environment-uid";
const MANAGED_LABEL = "preview.stacks.io/managed";
const PREVIEW_NAME_LABEL = "preview.stacks.io/preview-name";
const HEADLAMP_RECORD_LABEL = "preview.stacks.io/headlamp-record";
const TAILNET_FQDN_ANNOTATION = "tailscale.com/tailnet-fqdn";
const KUBERNETES_UID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringMap(value: unknown): Record<string, string> {
  const input = record(value);
  if (!input) return {};
  return Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function ownedLabels(name: string): Record<string, string> {
  return {
    [MANAGED_LABEL]: "true",
    [PREVIEW_NAME_LABEL]: name,
    [HEADLAMP_RECORD_LABEL]: "true",
  };
}

function secretName(name: string): string {
  return `headlamp-preview-${name}`;
}

function serviceName(name: string): string {
  return `kube-${name}-api-egress`;
}

function previewEnvironmentPath(name: string): string {
  return `/apis/preview.stacks.io/v1alpha1/namespaces/${PREVIEW_NAMESPACE}/previewenvironments/${encodeURIComponent(name)}`;
}

function secretCollectionPath(): string {
  return `/api/v1/namespaces/${PREVIEW_NAMESPACE}/secrets`;
}

function secretPath(name: string): string {
  return `${secretCollectionPath()}/${encodeURIComponent(secretName(name))}`;
}

function serviceCollectionPath(): string {
  return `/api/v1/namespaces/${TAILSCALE_NAMESPACE}/services`;
}

function servicePath(name: string): string {
  return `${serviceCollectionPath()}/${encodeURIComponent(serviceName(name))}`;
}

function tupleMatches(
  resource: Record<string, unknown>,
  identity: PreviewControlIdentity,
): string {
  const metadata = record(resource.metadata);
  const annotations = stringMap(metadata?.annotations);
  const spec = record(resource.spec);
  const provenance = record(spec?.provenance);
  const uid = metadata?.uid;
  if (
    metadata?.name !== identity.previewName ||
    metadata.namespace !== PREVIEW_NAMESPACE ||
    typeof uid !== "string" ||
    !KUBERNETES_UID.test(uid) ||
    metadata.deletionTimestamp !== undefined ||
    spec?.id !== identity.previewName ||
    provenance?.requestId !== identity.environmentRequestId ||
    spec.platformRevision !== identity.environmentPlatformRevision ||
    spec.sourceRevision !== identity.environmentSourceRevision ||
    spec.catalogDigest !== identity.catalogDigest ||
    annotations["preview.stacks.io/request-id"] !==
      identity.environmentRequestId ||
    annotations["preview.stacks.io/platform-revision"] !==
      identity.environmentPlatformRevision ||
    annotations["preview.stacks.io/source-revision"] !==
      identity.environmentSourceRevision ||
    annotations["preview.stacks.io/catalog-digest"] !== identity.catalogDigest
  ) {
    throw new PreviewHeadlampRegistrationError(
      "generation-mismatch",
      "current PreviewEnvironment does not match the requested Headlamp generation",
    );
  }
  return uid;
}

function assertResourceOwnership(
  resource: Record<string, unknown>,
  input: Readonly<{
    kind: "Secret" | "Service";
    namespace: string;
    resourceName: string;
    previewName: string;
    environmentUid: string;
  }>,
): void {
  const metadata = record(resource.metadata);
  const labels = stringMap(metadata?.labels);
  const annotations = stringMap(metadata?.annotations);
  const expectedLabels = ownedLabels(input.previewName);
  if (
    resource.kind !== input.kind ||
    metadata?.name !== input.resourceName ||
    metadata.namespace !== input.namespace ||
    Object.entries(expectedLabels).some(
      ([key, value]) => labels[key] !== value,
    ) ||
    annotations[ENVIRONMENT_UID_ANNOTATION] !== input.environmentUid
  ) {
    throw new PreviewHeadlampRegistrationError(
      "resource-ownership",
      `existing preview Headlamp ${input.kind} is not owned by the current environment`,
    );
  }
}

function metadataForUpdate(
  resource: Record<string, unknown>,
  desired: Record<string, unknown>,
): Record<string, unknown> {
  const current = record(resource.metadata);
  const wanted = record(desired.metadata)!;
  const resourceVersion = current?.resourceVersion;
  if (typeof resourceVersion !== "string" || !resourceVersion) {
    throw new PreviewHeadlampRegistrationError(
      "resource-ownership",
      "existing preview Headlamp resource has no resourceVersion",
    );
  }
  return {
    ...wanted,
    resourceVersion,
    ...(Array.isArray(current?.finalizers)
      ? { finalizers: current.finalizers }
      : {}),
    ...(Array.isArray(current?.ownerReferences)
      ? { ownerReferences: current.ownerReferences }
      : {}),
  };
}

export function buildPreviewHeadlampSecret(
  command: PreviewHeadlampRegistrationCommand,
  environmentUid: string,
): Record<string, unknown> {
  const name = command.identity.previewName;
  const configuration = JSON.stringify({
    bearerToken: command.credential.bearerToken,
    tlsClientConfig: {
      insecure: false,
      caData: command.credential.caData,
      serverName: command.credential.serverName,
    },
  });
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secretName(name),
      namespace: PREVIEW_NAMESPACE,
      labels: ownedLabels(name),
      annotations: { [ENVIRONMENT_UID_ANNOTATION]: environmentUid },
    },
    type: "Opaque",
    data: {
      name: Buffer.from(`preview-${name}`).toString("base64"),
      server: Buffer.from(
        `https://${serviceName(name)}.${TAILSCALE_NAMESPACE}.svc.cluster.local:443`,
      ).toString("base64"),
      config: Buffer.from(configuration).toString("base64"),
    },
  };
}

export function buildPreviewHeadlampEgressService(
  command: PreviewHeadlampRegistrationCommand,
  environmentUid: string,
): Record<string, unknown> {
  const name = command.identity.previewName;
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: serviceName(name),
      namespace: TAILSCALE_NAMESPACE,
      labels: ownedLabels(name),
      annotations: {
        [ENVIRONMENT_UID_ANNOTATION]: environmentUid,
        [TAILNET_FQDN_ANNOTATION]: `kube-${name}.tail286401.ts.net`,
      },
    },
    spec: {
      type: "ExternalName",
      externalName: "invalid.tailnet.internal",
      ports: [{ name: "https", port: 443, protocol: "TCP" }],
    },
  };
}

export class KubernetesPreviewHeadlampRegistrationAdapter
  implements PreviewHeadlampRegistrationPort
{
  private readonly fetchImpl: KubeFetch;

  constructor(options: KubernetesPreviewHeadlampRegistrationOptions) {
    this.fetchImpl = options.fetch;
  }

  async register(
    input: PreviewHeadlampRegistrationCommand,
  ): Promise<PreviewHeadlampRegistration> {
    const command = validatePreviewHeadlampRegistrationCommand(input);
    const before = await this.readPreviewEnvironment(command.identity);
    const environmentUid = tupleMatches(before, command.identity);
    const name = command.identity.previewName;

    await this.upsert({
      collectionPath: serviceCollectionPath(),
      resourcePath: servicePath(name),
      desired: buildPreviewHeadlampEgressService(command, environmentUid),
      ownership: {
        kind: "Service",
        namespace: TAILSCALE_NAMESPACE,
        resourceName: serviceName(name),
        previewName: name,
        environmentUid,
      },
    });
    await this.upsert({
      collectionPath: secretCollectionPath(),
      resourcePath: secretPath(name),
      desired: buildPreviewHeadlampSecret(command, environmentUid),
      ownership: {
        kind: "Secret",
        namespace: PREVIEW_NAMESPACE,
        resourceName: secretName(name),
        previewName: name,
        environmentUid,
      },
    });

    const after = await this.readPreviewEnvironment(command.identity);
    if (tupleMatches(after, command.identity) !== environmentUid) {
      throw new PreviewHeadlampRegistrationError(
        "generation-mismatch",
        "PreviewEnvironment was replaced while Headlamp registration was written",
      );
    }
    return Object.freeze({
      previewName: name,
      contextName: `preview-${name}`,
      environmentUid,
      secretName: secretName(name),
      serviceName: serviceName(name),
    });
  }

  private async readPreviewEnvironment(
    identity: PreviewControlIdentity,
  ): Promise<Record<string, unknown>> {
    const response = await this.request(
      previewEnvironmentPath(identity.previewName),
      { retries: 0 },
      "PreviewEnvironment read",
    );
    if (response.status === 404) {
      throw new PreviewHeadlampRegistrationError(
        "environment-not-found",
        "PreviewEnvironment was not found for Headlamp registration",
      );
    }
    if (!response.ok) {
      throw new PreviewHeadlampRegistrationError(
        "hub-unavailable",
        `PreviewEnvironment read failed with status ${response.status}`,
      );
    }
    return this.responseObject(response, "PreviewEnvironment read");
  }

  private async upsert(input: Readonly<{
    collectionPath: string;
    resourcePath: string;
    desired: Record<string, unknown>;
    ownership: Parameters<typeof assertResourceOwnership>[1];
  }>): Promise<void> {
    let current = await this.readOptional(
      input.resourcePath,
      `${input.ownership.kind} read`,
    );
    if (!current) {
      const created = await this.request(
        input.collectionPath,
        {
          method: "POST",
          body: JSON.stringify(input.desired),
          retries: 0,
        },
        `${input.ownership.kind} create`,
      );
      if (created.ok) return;
      if (created.status !== 409) {
        throw new PreviewHeadlampRegistrationError(
          "hub-unavailable",
          `${input.ownership.kind} create failed with status ${created.status}`,
        );
      }
      current = await this.readOptional(
        input.resourcePath,
        `${input.ownership.kind} conflict read`,
      );
      if (!current) {
        throw new PreviewHeadlampRegistrationError(
          "resource-ownership",
          `${input.ownership.kind} create conflicted without an owned resource`,
        );
      }
    }

    assertResourceOwnership(current, input.ownership);
    await this.replace(input, current, true);
  }

  private async replace(
    input: Readonly<{
      resourcePath: string;
      desired: Record<string, unknown>;
      ownership: Parameters<typeof assertResourceOwnership>[1];
    }>,
    current: Record<string, unknown>,
    retry: boolean,
  ): Promise<void> {
    const desired = {
      ...input.desired,
      metadata: metadataForUpdate(current, input.desired),
    };
    const response = await this.request(
      input.resourcePath,
      {
        method: "PUT",
        body: JSON.stringify(desired),
        retries: 0,
      },
      `${input.ownership.kind} update`,
    );
    if (response.ok) return;
    if (response.status === 409 && retry) {
      const latest = await this.readOptional(
        input.resourcePath,
        `${input.ownership.kind} update conflict read`,
      );
      if (latest) {
        assertResourceOwnership(latest, input.ownership);
        await this.replace(input, latest, false);
        return;
      }
    }
    throw new PreviewHeadlampRegistrationError(
      response.status === 409 ? "resource-ownership" : "hub-unavailable",
      `${input.ownership.kind} update failed with status ${response.status}`,
    );
  }

  private async readOptional(
    path: string,
    operation: string,
  ): Promise<Record<string, unknown> | null> {
    const response = await this.request(path, { retries: 0 }, operation);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new PreviewHeadlampRegistrationError(
        "hub-unavailable",
        `${operation} failed with status ${response.status}`,
      );
    }
    return this.responseObject(response, operation);
  }

  private async request(
    path: string,
    init: RequestInit & { retries?: number },
    operation: string,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(path, init);
    } catch (cause) {
      throw new PreviewHeadlampRegistrationError(
        "hub-unavailable",
        `${operation} could not reach the hub Kubernetes API`,
        { cause },
      );
    }
  }

  private async responseObject(
    response: Response,
    operation: string,
  ): Promise<Record<string, unknown>> {
    try {
      const value = await response.json();
      const parsed = record(value);
      if (parsed) return parsed;
    } catch {
      // The error below deliberately excludes response bodies and credentials.
    }
    throw new PreviewHeadlampRegistrationError(
      "hub-unavailable",
      `${operation} returned an invalid Kubernetes object`,
    );
  }
}
