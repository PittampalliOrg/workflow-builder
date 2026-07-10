import {
  PREVIEW_ENVIRONMENT_CAPABILITIES,
  PREVIEW_ENVIRONMENT_LIFECYCLES,
  PREVIEW_ENVIRONMENT_MODES,
  PREVIEW_ENVIRONMENT_ORIGINS,
  PREVIEW_ENVIRONMENT_OWNER_KINDS,
  PREVIEW_ENVIRONMENT_PROFILES,
  type ImmutableGitSha,
  type PreviewEnvironmentAllocation,
  type PreviewEnvironmentCapability,
  type PreviewEnvironmentCandidatePathPolicyPort,
  type PreviewEnvironmentLaunchOutcome,
  type PreviewEnvironmentLaunchPort,
  type PreviewEnvironmentLaunchSpec,
  type PreviewEnvironmentLifecycle,
  type PreviewEnvironmentMode,
  type PreviewEnvironmentImageOverrides,
  type PreviewEnvironmentLane,
  type PreviewEnvironmentOrigin,
  type PreviewEnvironmentOriginKind,
  type PreviewEnvironmentOwner,
  type PreviewEnvironmentOwnerKind,
  type PreviewEnvironmentPlacement,
  type PreviewEnvironmentProfile,
  type PreviewEnvironmentProvenance,
  type PreviewEnvironmentRevisionResolverPort,
  type PreviewEnvironmentUserLaunchInput,
  type PreviewEnvironmentUserLaunchPort,
  type PreviewEnvironmentVersionedServiceCatalogPort,
  type ValidatedPreviewEnvironmentLaunchSpec,
} from "$lib/server/application/ports/preview-environments";

export const PREVIEW_ENVIRONMENT_TTL_HOURS = {
  min: 1,
  max: 168,
} as const;

export type PreviewEnvironmentProfilePolicy = Readonly<{
  placement: PreviewEnvironmentPlacement;
  mode: PreviewEnvironmentMode;
  lifecycles: readonly PreviewEnvironmentLifecycle[];
  requiresServices: boolean;
}>;

export const PREVIEW_ENVIRONMENT_PROFILE_POLICIES = {
  "app-live": {
    placement: "dev-vcluster",
    mode: "live",
    lifecycles: ["ephemeral", "retained"],
    requiresServices: true,
  },
  "manifest-candidate": {
    placement: "dev-vcluster",
    mode: "reconciled",
    lifecycles: ["ephemeral", "retained"],
    requiresServices: false,
  },
  "host-candidate": {
    placement: "dev-physical",
    mode: "reconciled",
    lifecycles: ["exclusive"],
    requiresServices: false,
  },
} as const satisfies Record<
  PreviewEnvironmentProfile,
  PreviewEnvironmentProfilePolicy
>;

export type PreviewEnvironmentValidationIssueCode =
  | "required"
  | "invalid-value"
  | "invalid-sha"
  | "invalid-service"
  | "duplicate"
  | "out-of-range"
  | "profile-capability-mismatch"
  | "mixed-live-and-infrastructure"
  | "mode-not-allowed"
  | "lifecycle-not-allowed"
  | "lane-not-allowed";

export type PreviewEnvironmentValidationIssue = Readonly<{
  path: string;
  code: PreviewEnvironmentValidationIssueCode;
  message: string;
}>;

export class PreviewEnvironmentValidationError extends Error {
  constructor(
    public readonly issues: readonly PreviewEnvironmentValidationIssue[],
  ) {
    super(
      issues.length === 1
        ? issues[0].message
        : `Invalid preview environment launch spec (${issues.length} issues)`,
    );
    this.name = "PreviewEnvironmentValidationError";
  }
}

export type PreviewEnvironmentCapabilityRoute = Readonly<{
  profile: PreviewEnvironmentProfile;
  lane: PreviewEnvironmentLane;
  placement: PreviewEnvironmentPlacement;
}>;

const HOST_CAPABILITIES = new Set<PreviewEnvironmentCapability>([
  "host-control-plane",
  "host-networking",
  "host-storage",
  "node-runtime",
]);

const MANAGEMENT_CAPABILITIES = new Set<PreviewEnvironmentCapability>([
  "gitops-management-plane",
]);

const MANIFEST_CAPABILITIES = new Set<PreviewEnvironmentCapability>([
  "namespaced-manifests",
  "virtual-cluster-control-plane",
]);

const PREVIEW_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED_PREVIEW_ENVIRONMENT_NAMES = new Set([
  "ganpilot",
  "ganvalidate",
  "mtxdev1",
  "mtxtmpl1",
  "preview6",
  "test3",
]);
const SERVICE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const FULL_GIT_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;
const IMMUTABLE_GHCR_IMAGE_PATTERN =
  /^ghcr\.io\/pittampalliorg\/[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?@sha256:[0-9a-f]{64}$/;
const RFC3339_UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

function issue(
  issues: PreviewEnvironmentValidationIssue[],
  path: string,
  code: PreviewEnvironmentValidationIssueCode,
  message: string,
): void {
  issues.push({ path, code, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enumValue<T extends string>(
  value: unknown,
  options: readonly T[],
  path: string,
  issues: PreviewEnvironmentValidationIssue[],
): T | null {
  if (
    typeof value === "string" &&
    (options as readonly string[]).includes(value)
  ) {
    return value as T;
  }
  issue(
    issues,
    path,
    "invalid-value",
    `${path} must be one of: ${options.join(", ")}`,
  );
  return null;
}

function requiredText(
  value: unknown,
  path: string,
  issues: PreviewEnvironmentValidationIssue[],
  maxLength = 512,
): string | null {
  if (typeof value !== "string" || !value.trim()) {
    issue(issues, path, "required", `${path} is required`);
    return null;
  }
  const normalized = value.trim();
  if (
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    issue(issues, path, "invalid-value", `${path} is invalid`);
    return null;
  }
  return normalized;
}

function immutableGitSha(
  value: unknown,
  path: string,
  issues: PreviewEnvironmentValidationIssue[],
): ImmutableGitSha | null {
  if (typeof value !== "string" || !FULL_GIT_SHA_PATTERN.test(value)) {
    issue(
      issues,
      path,
      "invalid-sha",
      `${path} must be a complete 40-character hexadecimal Git SHA`,
    );
    return null;
  }
  return value.toLowerCase() as ImmutableGitSha;
}

function isValidRfc3339Utc(value: string): boolean {
  const match = RFC3339_UTC_PATTERN.exec(value);
  if (!match) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return false;
  return (
    parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() + 1 === Number(match[2]) &&
    parsed.getUTCDate() === Number(match[3]) &&
    parsed.getUTCHours() === Number(match[4]) &&
    parsed.getUTCMinutes() === Number(match[5]) &&
    parsed.getUTCSeconds() === Number(match[6])
  );
}

function routeKnownCapabilities(
  capabilities: readonly PreviewEnvironmentCapability[],
  issues: PreviewEnvironmentValidationIssue[],
): PreviewEnvironmentCapabilityRoute | null {
  const hasLive = capabilities.some((capability) =>
    ["service-live-sync", "immutable-image-replay"].includes(capability),
  );
  const hasHost = capabilities.some((capability) =>
    HOST_CAPABILITIES.has(capability),
  );
  const hasManifest = capabilities.some((capability) =>
    MANIFEST_CAPABILITIES.has(capability),
  );
  const hasManagement = capabilities.some((capability) =>
    MANAGEMENT_CAPABILITIES.has(capability),
  );

  if (hasLive && (hasHost || hasManifest || hasManagement)) {
    issue(
      issues,
      "capabilities",
      "mixed-live-and-infrastructure",
      "service-live-sync and infrastructure validation require separate preview phases",
    );
    return null;
  }

  if (hasHost && hasManagement) {
    issue(
      issues,
      "capabilities",
      "profile-capability-mismatch",
      "host and management capabilities require separate preview phases",
    );
    return null;
  }

  const profile: PreviewEnvironmentProfile = hasHost
    ? "host-candidate"
    : hasManifest || hasManagement
      ? "manifest-candidate"
      : "app-live";
  const policy = PREVIEW_ENVIRONMENT_PROFILE_POLICIES[profile];
  return {
    profile,
    lane: hasManagement ? "management" : "application",
    placement: policy.placement,
  };
}

/** Route a trusted capability set to the narrowest truthful dev-only substrate. */
export function routePreviewEnvironmentCapabilities(
  capabilities: readonly PreviewEnvironmentCapability[],
): PreviewEnvironmentCapabilityRoute {
  const issues: PreviewEnvironmentValidationIssue[] = [];
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    issue(
      issues,
      "capabilities",
      "required",
      "at least one preview capability is required",
    );
  } else {
    for (const [index, capability] of capabilities.entries()) {
      if (
        !(PREVIEW_ENVIRONMENT_CAPABILITIES as readonly string[]).includes(
          capability,
        )
      ) {
        issue(
          issues,
          `capabilities[${index}]`,
          "invalid-value",
          `unsupported preview capability: ${String(capability)}`,
        );
      }
    }
  }
  if (issues.length > 0) throw new PreviewEnvironmentValidationError(issues);
  const route = routeKnownCapabilities(capabilities, issues);
  if (!route || issues.length > 0)
    throw new PreviewEnvironmentValidationError(issues);
  return route;
}

function validateOwner(
  value: unknown,
  issues: PreviewEnvironmentValidationIssue[],
): PreviewEnvironmentOwner | null {
  if (!isRecord(value)) {
    issue(issues, "owner", "required", "owner is required");
    return null;
  }
  const kind = enumValue<PreviewEnvironmentOwnerKind>(
    value.kind,
    PREVIEW_ENVIRONMENT_OWNER_KINDS,
    "owner.kind",
    issues,
  );
  const id = requiredText(value.id, "owner.id", issues, 128);
  if (id && !OWNER_ID_PATTERN.test(id)) {
    issue(
      issues,
      "owner.id",
      "invalid-value",
      "owner.id contains unsupported characters",
    );
  }
  return kind && id ? Object.freeze({ kind, id }) : null;
}

function validateOrigin(
  value: unknown,
  issues: PreviewEnvironmentValidationIssue[],
): PreviewEnvironmentOrigin | null {
  if (!isRecord(value)) {
    issue(issues, "origin", "required", "origin is required");
    return null;
  }
  const kind = enumValue<PreviewEnvironmentOriginKind>(
    value.kind,
    PREVIEW_ENVIRONMENT_ORIGINS,
    "origin.kind",
    issues,
  );
  let reference: string | null | undefined;
  if (value.reference != null) {
    reference = requiredText(value.reference, "origin.reference", issues, 512);
  }
  if (
    kind &&
    ["pull-request", "workflow", "interactive-session"].includes(kind) &&
    !reference
  ) {
    issue(
      issues,
      "origin.reference",
      "required",
      `origin.reference is required for ${kind}`,
    );
  }
  if (!kind) return null;
  return Object.freeze({
    kind,
    ...(reference === undefined ? {} : { reference }),
  });
}

function validateProvenance(
  value: unknown,
  issues: PreviewEnvironmentValidationIssue[],
): PreviewEnvironmentProvenance | null {
  if (!isRecord(value)) {
    issue(issues, "provenance", "required", "provenance is required");
    return null;
  }
  const requestId = requiredText(
    value.requestId,
    "provenance.requestId",
    issues,
    256,
  );
  const requestedAt = requiredText(
    value.requestedAt,
    "provenance.requestedAt",
    issues,
    64,
  );
  if (requestedAt && !isValidRfc3339Utc(requestedAt)) {
    issue(
      issues,
      "provenance.requestedAt",
      "invalid-value",
      "provenance.requestedAt must be a valid RFC3339 UTC timestamp",
    );
  }
  const platformRepository = requiredText(
    value.platformRepository,
    "provenance.platformRepository",
    issues,
  );
  const sourceRepository = requiredText(
    value.sourceRepository,
    "provenance.sourceRepository",
    issues,
  );
  let parentEnvironmentId: string | null | undefined;
  if (value.parentEnvironmentId != null) {
    parentEnvironmentId = requiredText(
      value.parentEnvironmentId,
      "provenance.parentEnvironmentId",
      issues,
      256,
    );
  }
  if (!requestId || !requestedAt || !platformRepository || !sourceRepository) {
    return null;
  }
  return Object.freeze({
    requestId,
    requestedAt,
    platformRepository,
    sourceRepository,
    ...(parentEnvironmentId === undefined ? {} : { parentEnvironmentId }),
  });
}

function validateServices(
  value: unknown,
  issues: PreviewEnvironmentValidationIssue[],
): readonly string[] {
  if (!Array.isArray(value)) {
    issue(issues, "services", "invalid-value", "services must be an array");
    return [];
  }
  const services: string[] = [];
  const seen = new Set<string>();
  for (const [index, service] of value.entries()) {
    if (typeof service !== "string" || !SERVICE_NAME_PATTERN.test(service)) {
      issue(
        issues,
        `services[${index}]`,
        "invalid-service",
        "service names must be lowercase Kubernetes DNS labels",
      );
      continue;
    }
    if (seen.has(service)) {
      issue(
        issues,
        `services[${index}]`,
        "duplicate",
        `duplicate service: ${service}`,
      );
      continue;
    }
    seen.add(service);
    services.push(service);
  }
  return Object.freeze(services);
}

function validateCandidatePaths(
  value: unknown,
  issues: PreviewEnvironmentValidationIssue[],
): readonly string[] {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 64) {
    issue(
      issues,
      "candidatePaths",
      "invalid-value",
      "candidatePaths must be an array of at most 64 paths",
    );
    return Object.freeze([]);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (
      typeof raw !== "string" ||
      !raw ||
      raw.length > 512 ||
      raw.startsWith("/") ||
      raw.includes("\\") ||
      raw.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      issue(
        issues,
        `candidatePaths[${index}]`,
        "invalid-value",
        "candidate paths must be normalized repository-relative paths",
      );
      continue;
    }
    if (seen.has(raw)) {
      issue(
        issues,
        `candidatePaths[${index}]`,
        "duplicate",
        `duplicate candidate path: ${raw}`,
      );
      continue;
    }
    seen.add(raw);
    result.push(raw);
  }
  return Object.freeze(result.sort());
}

function validateCapabilities(
  value: unknown,
  issues: PreviewEnvironmentValidationIssue[],
): readonly PreviewEnvironmentCapability[] {
  if (!Array.isArray(value) || value.length === 0) {
    issue(
      issues,
      "capabilities",
      "required",
      "at least one preview capability is required",
    );
    return [];
  }
  const capabilities: PreviewEnvironmentCapability[] = [];
  const seen = new Set<string>();
  for (const [index, capability] of value.entries()) {
    if (
      typeof capability !== "string" ||
      !(PREVIEW_ENVIRONMENT_CAPABILITIES as readonly string[]).includes(
        capability,
      )
    ) {
      issue(
        issues,
        `capabilities[${index}]`,
        "invalid-value",
        `unsupported preview capability: ${String(capability)}`,
      );
      continue;
    }
    if (seen.has(capability)) {
      issue(
        issues,
        `capabilities[${index}]`,
        "duplicate",
        `duplicate capability: ${capability}`,
      );
      continue;
    }
    seen.add(capability);
    capabilities.push(capability as PreviewEnvironmentCapability);
  }
  return Object.freeze(capabilities);
}

function validateAllocation(
  value: unknown,
  issues: PreviewEnvironmentValidationIssue[],
): PreviewEnvironmentAllocation | null {
  if (!isRecord(value)) {
    issue(issues, "allocation", "required", "allocation is required");
    return null;
  }
  if (value.kind === "cold" && Object.keys(value).length === 1) {
    return Object.freeze({ kind: "cold" });
  }
  issue(
    issues,
    "allocation.kind",
    "invalid-value",
    "PreviewEnvironment allocation must be exactly {kind: cold}",
  );
  return null;
}

function validateImageOverrides(
  value: unknown,
  services: readonly string[],
  issues: PreviewEnvironmentValidationIssue[],
): PreviewEnvironmentImageOverrides {
  if (value == null) return Object.freeze({});
  if (!isRecord(value)) {
    issue(
      issues,
      "imageOverrides",
      "invalid-value",
      "imageOverrides must be an object",
    );
    return Object.freeze({});
  }
  const allowed = new Set(services);
  const overrides: Record<string, string> = {};
  for (const [service, image] of Object.entries(value)) {
    if (!SERVICE_NAME_PATTERN.test(service) || !allowed.has(service)) {
      issue(
        issues,
        `imageOverrides.${service}`,
        "invalid-service",
        "image override keys must name a requested service",
      );
      continue;
    }
    if (
      typeof image !== "string" ||
      !IMMUTABLE_GHCR_IMAGE_PATTERN.test(image)
    ) {
      issue(
        issues,
        `imageOverrides.${service}`,
        "invalid-value",
        "image overrides must be immutable PittampalliOrg GHCR digest references",
      );
      continue;
    }
    overrides[service] = image;
  }
  return Object.freeze(overrides);
}

/** Validate untrusted launch input and produce the only DTO accepted by adapters. */
export function validatePreviewEnvironmentLaunchSpec(
  input: PreviewEnvironmentLaunchSpec,
  catalogDigest: `sha256:${string}`,
): ValidatedPreviewEnvironmentLaunchSpec {
  const issues: PreviewEnvironmentValidationIssue[] = [];
  const raw: Record<string, unknown> = isRecord(input) ? input : {};
  if (!isRecord(input)) {
    issue(
      issues,
      "launchSpec",
      "required",
      "preview environment launch spec is required",
    );
  }
  const name = requiredText(raw.name, "name", issues, 40);
  if (name && !PREVIEW_NAME_PATTERN.test(name)) {
    issue(
      issues,
      "name",
      "invalid-value",
      "name must be a lowercase DNS label with at most 40 characters",
    );
  } else if (
    name &&
    (name.startsWith("pool-") || RESERVED_PREVIEW_ENVIRONMENT_NAMES.has(name))
  ) {
    issue(
      issues,
      "name",
      "invalid-value",
      "name is reserved for legacy preview retirement",
    );
  }
  const profile = enumValue<PreviewEnvironmentProfile>(
    raw.profile,
    PREVIEW_ENVIRONMENT_PROFILES,
    "profile",
    issues,
  );
  const lane = enumValue<PreviewEnvironmentLane>(
    raw.lane ?? "application",
    ["application", "management"],
    "lane",
    issues,
  );
  const capabilities = validateCapabilities(raw.capabilities, issues);
  const platformRevision = immutableGitSha(
    raw.platformRevision,
    "platformRevision",
    issues,
  );
  const sourceRevision = immutableGitSha(
    raw.sourceRevision,
    "sourceRevision",
    issues,
  );
  const services = validateServices(raw.services, issues);
  const candidatePaths = validateCandidatePaths(raw.candidatePaths, issues);
  const imageOverrides = validateImageOverrides(
    raw.imageOverrides,
    services,
    issues,
  );
  const owner = validateOwner(raw.owner, issues);
  const origin = validateOrigin(raw.origin, issues);
  const mode = enumValue<PreviewEnvironmentMode>(
    raw.mode,
    PREVIEW_ENVIRONMENT_MODES,
    "mode",
    issues,
  );
  const lifecycle = enumValue<PreviewEnvironmentLifecycle>(
    raw.lifecycle,
    PREVIEW_ENVIRONMENT_LIFECYCLES,
    "lifecycle",
    issues,
  );
  const allocation = validateAllocation(raw.allocation, issues);
  const provenance = validateProvenance(raw.provenance, issues);
  const ttlHours = raw.ttlHours;
  const maxTtlHours =
    lane === "management" ? 24 : PREVIEW_ENVIRONMENT_TTL_HOURS.max;
  if (
    typeof ttlHours !== "number" ||
    !Number.isInteger(ttlHours) ||
    ttlHours < PREVIEW_ENVIRONMENT_TTL_HOURS.min ||
    ttlHours > maxTtlHours
  ) {
    issue(
      issues,
      "ttlHours",
      "out-of-range",
      `ttlHours must be an integer from ${PREVIEW_ENVIRONMENT_TTL_HOURS.min} to ${maxTtlHours}`,
    );
  }

  const route =
    capabilities.length > 0
      ? routeKnownCapabilities(capabilities, issues)
      : null;
  if (profile && route && profile !== route.profile) {
    issue(
      issues,
      "profile",
      "profile-capability-mismatch",
      `capabilities require profile ${route.profile}, not ${profile}`,
    );
  }
  if (lane && route && lane !== route.lane) {
    issue(
      issues,
      "lane",
      "profile-capability-mismatch",
      `capabilities require lane ${route.lane}, not ${lane}`,
    );
  }
  if (lane === "management" && profile !== "manifest-candidate") {
    issue(
      issues,
      "lane",
      "lane-not-allowed",
      "only manifest-candidate can use the management lane",
    );
  }

  const policy = profile ? PREVIEW_ENVIRONMENT_PROFILE_POLICIES[profile] : null;
  const appAcceptance = profile === "app-live" && mode === "reconciled";
  if (profile === "app-live" && mode) {
    const requiredCapability =
      mode === "live" ? "service-live-sync" : "immutable-image-replay";
    const incompatibleCapability =
      mode === "live" ? "immutable-image-replay" : "service-live-sync";
    if (
      !capabilities.includes(requiredCapability) ||
      capabilities.includes(incompatibleCapability)
    ) {
      issue(
        issues,
        "capabilities",
        "profile-capability-mismatch",
        `app-live ${mode} mode requires ${requiredCapability} and forbids ${incompatibleCapability}`,
      );
    }
  }
  if (
    profile === "app-live" &&
    mode === "live" &&
    owner &&
    owner.kind !== "user" &&
    !(owner.kind === "automation" && origin?.kind === "pull-request")
  ) {
    issue(
      issues,
      "owner.kind",
      "invalid-value",
      "live app-live previews require a user owner or pull-request automation owner",
    );
  }
  if (policy && mode && mode !== policy.mode && !appAcceptance) {
    issue(
      issues,
      "mode",
      "mode-not-allowed",
      `${profile} requires ${policy.mode} mode`,
    );
  }
  if (
    policy &&
    lifecycle &&
    !(policy.lifecycles as readonly PreviewEnvironmentLifecycle[]).includes(
      lifecycle,
    )
  ) {
    issue(
      issues,
      "lifecycle",
      "lifecycle-not-allowed",
      `${profile} requires lifecycle ${policy.lifecycles.join(" or ")}`,
    );
  }
  if (lane === "management" && lifecycle && lifecycle !== "ephemeral") {
    issue(
      issues,
      "lifecycle",
      "lifecycle-not-allowed",
      "manifest-candidate management lane requires ephemeral lifecycle",
    );
  }
  if (policy?.requiresServices && services.length === 0) {
    issue(
      issues,
      "services",
      "required",
      `${profile} requires at least one service`,
    );
  }
  if (profile === "manifest-candidate" && candidatePaths.length === 0) {
    issue(
      issues,
      "candidatePaths",
      "required",
      "manifest-candidate requires candidatePaths",
    );
  }
  if (
    profile &&
    profile !== "manifest-candidate" &&
    candidatePaths.length > 0
  ) {
    // host-candidate paths never enter this launch model. The PR broker returns
    // a typed preview-host-candidate.sh operator action carrying those paths;
    // only namespaced manifest candidates are directly launchable here.
    issue(
      issues,
      "candidatePaths",
      "invalid-value",
      "candidatePaths are allowed only for manifest-candidate",
    );
  }
  if (mode === "live" && Object.keys(imageOverrides).length > 0) {
    issue(
      issues,
      "imageOverrides",
      "mode-not-allowed",
      "live mode uses dev sync and cannot carry production image overrides",
    );
  }
  if (appAcceptance && Object.keys(imageOverrides).length === 0) {
    issue(
      issues,
      "imageOverrides",
      "required",
      "reconciled app-live acceptance requires immutable production image overrides",
    );
  }
  if (
    issues.length > 0 ||
    !name ||
    !profile ||
    !lane ||
    !route ||
    !platformRevision ||
    !sourceRevision ||
    !owner ||
    !origin ||
    !mode ||
    !lifecycle ||
    !allocation ||
    !provenance ||
    typeof ttlHours !== "number"
  ) {
    throw new PreviewEnvironmentValidationError(issues);
  }

  return Object.freeze({
    name,
    profile,
    lane,
    capabilities,
    placement: route.placement,
    platformRevision,
    sourceRevision,
    catalogDigest,
    services,
    candidatePaths,
    owner,
    origin,
    ttlHours,
    mode,
    imageOverrides,
    lifecycle,
    allocation,
    provenance,
  });
}

export type ApplicationPreviewEnvironmentServiceDeps = Readonly<{
  vcluster: PreviewEnvironmentLaunchPort;
  physicalDev: PreviewEnvironmentLaunchPort;
  serviceCatalog: PreviewEnvironmentVersionedServiceCatalogPort;
  candidatePaths?: PreviewEnvironmentCandidatePathPolicyPort;
  revisions?: PreviewEnvironmentRevisionResolverPort;
  defaults?: Readonly<{
    platformRepository: string;
    platformRef: string;
    sourceRepository: string;
    sourceRef: string;
    ttlHours?: number;
  }>;
  now?: () => Date;
  requestId?: () => string;
}>;

export class PreviewEnvironmentRevisionResolutionError extends Error {
  constructor(
    public readonly field: "platform" | "source",
    public readonly repository: string,
    public readonly ref: string,
    options?: ErrorOptions,
  ) {
    super(`Unable to resolve ${field} ref '${ref}' in ${repository}`, options);
    this.name = "PreviewEnvironmentRevisionResolutionError";
  }
}

export class PreviewEnvironmentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewEnvironmentUnavailableError";
  }
}

export class PreviewEnvironmentOperatorActionRequiredError extends Error {
  constructor(
    public readonly profile: "manifest-candidate" | "host-candidate",
    public readonly command:
      | "preview-management-candidate.sh"
      | "preview-host-candidate.sh",
  ) {
    super(`${profile} requires the operator-controlled ${command} lane`);
    this.name = "PreviewEnvironmentOperatorActionRequiredError";
  }
}

const DEFAULT_CAPABILITY: Record<
  PreviewEnvironmentProfile,
  PreviewEnvironmentCapability
> = {
  "app-live": "service-live-sync",
  "manifest-candidate": "namespaced-manifests",
  "host-candidate": "host-control-plane",
};

function isKnownProfile(value: unknown): value is PreviewEnvironmentProfile {
  return (
    typeof value === "string" &&
    (PREVIEW_ENVIRONMENT_PROFILES as readonly string[]).includes(value)
  );
}

/** Validate once, then route the immutable command through an injected adapter. */
export class ApplicationPreviewEnvironmentService implements PreviewEnvironmentUserLaunchPort {
  constructor(
    private readonly deps: ApplicationPreviewEnvironmentServiceDeps,
  ) {}

  previewNativeServices(): readonly string[] {
    return this.deps.serviceCatalog.listPreviewNativeServices();
  }

  async launch(
    input: PreviewEnvironmentLaunchSpec,
  ): Promise<PreviewEnvironmentLaunchOutcome> {
    const validated = validatePreviewEnvironmentLaunchSpec(
      input,
      this.deps.serviceCatalog.currentDigest(),
    );
    let command = validated;
    if (validated.profile === "app-live") {
      try {
        const services = this.deps.serviceCatalog.assertPreviewNativeServices(
          validated.services,
        );
        command = Object.freeze({
          ...validated,
          services: Object.freeze([...services]),
        });
      } catch (cause) {
        throw new PreviewEnvironmentValidationError([
          {
            path: "services",
            code: "invalid-service",
            message:
              cause instanceof Error
                ? cause.message
                : "Unsupported preview-native service set",
          },
        ]);
      }
    }
    if (command.profile === "manifest-candidate") {
      if (command.lane === "management") {
        throw new PreviewEnvironmentOperatorActionRequiredError(
          "manifest-candidate",
          "preview-management-candidate.sh",
        );
      }
      if (!this.deps.candidatePaths) {
        throw new PreviewEnvironmentUnavailableError(
          "Manifest candidate path policy is not configured",
        );
      }
      command = Object.freeze({
        ...command,
        candidatePaths: Object.freeze([
          ...this.deps.candidatePaths.assertManifestCandidatePaths(
            command.candidatePaths,
          ),
        ]),
      });
    }
    const port =
      command.placement === "dev-vcluster"
        ? this.deps.vcluster
        : this.deps.physicalDev;
    return port.launch(command);
  }

  /**
   * Authenticated human launch. Repository identity, owner, timestamps, and
   * request provenance are created here; inbound adapters cannot assert them.
   */
  async launchForUser(
    input: PreviewEnvironmentUserLaunchInput,
  ): Promise<PreviewEnvironmentLaunchOutcome> {
    const defaults = this.deps.defaults;
    if (
      !defaults ||
      !this.deps.revisions ||
      !this.deps.now ||
      !this.deps.requestId
    ) {
      throw new PreviewEnvironmentUnavailableError(
        "Preview launch context is not configured",
      );
    }
    const requestedProfile = input.profile ?? "app-live";
    const effectiveProfile = isKnownProfile(requestedProfile)
      ? requestedProfile
      : "app-live";
    const policy = PREVIEW_ENVIRONMENT_PROFILE_POLICIES[effectiveProfile];
    const platformRevision = await this.resolveRevision(
      "platform",
      defaults.platformRepository,
      input.platformRevision,
      input.platformRef ??
        (input.platformRevision == null ? defaults.platformRef : null),
    );
    const sourceRevision = await this.resolveRevision(
      "source",
      defaults.sourceRepository,
      input.sourceRevision,
      input.sourceRef ??
        (input.sourceRevision == null ? defaults.sourceRef : null),
    );
    const now = this.deps.now();
    const requestId = this.deps.requestId();
    const lifecycle =
      input.lifecycle ??
      (policy.lifecycles.length === 1
        ? policy.lifecycles[0]
        : effectiveProfile === "manifest-candidate"
          ? "ephemeral"
          : "retained");
    const allocation = { kind: "cold" as const };

    return this.launch({
      name: input.name,
      profile: requestedProfile,
      lane: input.lane ?? "application",
      capabilities: input.capabilities ?? [
        DEFAULT_CAPABILITY[effectiveProfile],
      ],
      platformRevision,
      sourceRevision,
      services:
        input.services ??
        (effectiveProfile === "app-live"
          ? this.deps.serviceCatalog.listPreviewNativeServices()
          : []),
      candidatePaths: input.candidatePaths ?? [],
      owner: { kind: "user", id: input.userId },
      origin: { kind: "user" },
      ttlHours: input.ttlHours ?? defaults.ttlHours ?? 24,
      mode: policy.mode,
      lifecycle,
      allocation,
      provenance: {
        requestId,
        requestedAt: now.toISOString(),
        platformRepository: defaults.platformRepository,
        sourceRepository: defaults.sourceRepository,
        ...(input.provenance?.parentEnvironmentId == null
          ? {}
          : {
              parentEnvironmentId: input.provenance.parentEnvironmentId,
            }),
      },
    });
  }

  private async resolveRevision(
    field: "platform" | "source",
    repository: string,
    revision: string | null | undefined,
    ref: string | null | undefined,
  ): Promise<string> {
    if (revision != null && ref != null) {
      throw new PreviewEnvironmentValidationError([
        {
          path: `${field}Revision`,
          code: "invalid-value",
          message: `provide ${field}Revision or ${field}Ref, not both`,
        },
      ]);
    }
    const selector = revision ?? ref?.trim();
    if (!selector) {
      throw new PreviewEnvironmentValidationError([
        {
          path: `${field}Ref`,
          code: "required",
          message: `${field}Revision or ${field}Ref is required`,
        },
      ]);
    }
    try {
      const resolved = await this.deps.revisions!.resolve({
        repository,
        ref: selector,
      });
      if (revision != null && resolved !== revision.toLowerCase()) {
        throw new Error(
          `${field} revision authority returned ${resolved}, expected ${revision.toLowerCase()}`,
        );
      }
      return resolved;
    } catch (cause) {
      throw new PreviewEnvironmentRevisionResolutionError(
        field,
        repository,
        selector,
        { cause },
      );
    }
  }
}
