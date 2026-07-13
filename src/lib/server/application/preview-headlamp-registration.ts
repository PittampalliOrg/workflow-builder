import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import {
  PreviewHeadlampRegistrationError,
  type PreviewControlIdentity,
  type PreviewHeadlampCredential,
  type PreviewHeadlampRegistration,
  type PreviewHeadlampRegistrationCommand,
  type PreviewHeadlampRegistrationPort,
} from "$lib/server/application/ports";

const TOKEN = /^[A-Za-z0-9._-]{20,8192}$/;
const UID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MAX_CA_DATA_BYTES = 24 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function canonicalBase64(value: string): boolean {
  if (
    value.length < 4 ||
    value.length > Math.ceil(MAX_CA_DATA_BYTES / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length === 0 ||
    decoded.length > MAX_CA_DATA_BYTES ||
    decoded.toString("base64") !== value
  ) {
    return false;
  }
  const pem = decoded.toString("utf8");
  return (
    pem.includes("-----BEGIN CERTIFICATE-----") &&
    pem.includes("-----END CERTIFICATE-----")
  );
}

export function validatePreviewHeadlampCredential(
  value: unknown,
  previewName: string,
): PreviewHeadlampCredential {
  const input = record(value);
  if (
    !input ||
    !exactKeys(input, ["bearerToken", "caData", "serverName"]) ||
    typeof input.bearerToken !== "string" ||
    !TOKEN.test(input.bearerToken) ||
    typeof input.caData !== "string" ||
    !canonicalBase64(input.caData) ||
    input.serverName !== `${previewName}.vcluster-${previewName}`
  ) {
    throw new PreviewHeadlampRegistrationError(
      "invalid-input",
      "preview Headlamp credential is invalid",
    );
  }
  return Object.freeze({
    bearerToken: input.bearerToken,
    caData: input.caData,
    serverName: input.serverName,
  });
}

export function validatePreviewHeadlampRegistrationCommand(
  value: unknown,
): PreviewHeadlampRegistrationCommand {
  const input = record(value);
  const identityValue = record(input?.identity);
  if (
    !input ||
    !exactKeys(input, ["identity", "credential"]) ||
    !identityValue ||
    !exactKeys(identityValue, [
      "previewName",
      "environmentRequestId",
      "environmentPlatformRevision",
      "environmentSourceRevision",
      "catalogDigest",
    ]) ||
    Object.values(identityValue).some((item) => typeof item !== "string")
  ) {
    throw new PreviewHeadlampRegistrationError(
      "invalid-input",
      "preview Headlamp registration command is invalid",
    );
  }

  let identity: PreviewControlIdentity;
  try {
    identity = validatePreviewControlIdentity(
      identityValue as unknown as PreviewControlIdentity,
    );
  } catch (cause) {
    throw new PreviewHeadlampRegistrationError(
      "invalid-input",
      "preview Headlamp identity is invalid",
      { cause },
    );
  }
  return Object.freeze({
    identity,
    credential: validatePreviewHeadlampCredential(
      input.credential,
      identity.previewName,
    ),
  });
}

/** Driving use case; transport auth remains at the HTTP edge. */
export class ApplicationPreviewHeadlampRegistrationService {
  constructor(private readonly registrations: PreviewHeadlampRegistrationPort) {}

  async register(command: unknown): Promise<PreviewHeadlampRegistration> {
    const validated = validatePreviewHeadlampRegistrationCommand(command);
    const registration = await this.registrations.register(validated);
    const name = validated.identity.previewName;
    if (
      registration.previewName !== name ||
      registration.contextName !== `preview-${name}` ||
      registration.secretName !== `headlamp-preview-${name}` ||
      registration.serviceName !== `kube-${name}-api-egress` ||
      !UID.test(registration.environmentUid)
    ) {
      throw new PreviewHeadlampRegistrationError(
        "hub-unavailable",
        "preview Headlamp registration returned an invalid receipt",
      );
    }
    return registration;
  }
}
