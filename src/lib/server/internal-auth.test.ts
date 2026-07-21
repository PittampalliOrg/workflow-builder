import { beforeEach, describe, expect, it, vi } from "vitest";

const privateEnv = vi.hoisted(() => ({
  INTERNAL_API_TOKEN: "shared-token",
  DRASI_INCIDENT_INGEST_TOKEN: "drasi-token",
  PREVIEW_ACTION_INTERNAL_TOKEN: "preview-token",
  PREVIEW_CONTROL_BROKER_TOKEN: "broker-token",
  PREVIEW_ACCEPTED_IMAGE_REUSE_TOKEN: "reuse-token",
  PREVIEW_GOVERNANCE_DISPATCH_TOKEN: "governance-dispatch-token",
  PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN: "",
  PREVIEW_CONTROL_CAPABILITY_TOKEN: "d".repeat(64),
  PREVIEW_ENVIRONMENT_NAME: "feature-one",
  PREVIEW_ENVIRONMENT_REQUEST_ID: "request-1",
  PREVIEW_ENVIRONMENT_PLATFORM_REVISION: "a".repeat(40),
  PREVIEW_ENVIRONMENT_SOURCE_REVISION: "b".repeat(40),
  PREVIEW_ENVIRONMENT_CATALOG_DIGEST: `sha256:${"c".repeat(64)}`,
}));

vi.mock("$env/dynamic/private", () => ({ env: privateEnv }));

import {
  requireInternalOrPreviewControlRead,
  requirePreviewActionInternal,
  requirePreviewGovernanceDispatch,
  requirePreviewAcceptedImageReuse,
  requirePreviewControlBroker,
  validateDrasiIncidentIngestToken,
  validateInternalToken,
  validateInternalOrPreviewControlRead,
  validatePreviewActionInternalToken,
  validatePreviewGovernanceDispatchToken,
  validatePreviewAcceptedImageReuseToken,
  validatePreviewControlBrokerToken,
} from "$lib/server/internal-auth";
import {
  derivePreviewControlCapability,
  type PreviewControlIdentity,
} from "$lib/server/preview-control-capability";

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/internal", { headers });
}

describe("preview action internal authentication", () => {
  beforeEach(() => {
    privateEnv.INTERNAL_API_TOKEN = "shared-token";
    privateEnv.DRASI_INCIDENT_INGEST_TOKEN = "drasi-token";
    privateEnv.PREVIEW_ACTION_INTERNAL_TOKEN = "preview-token";
    privateEnv.PREVIEW_CONTROL_BROKER_TOKEN = "broker-token";
    privateEnv.PREVIEW_ACCEPTED_IMAGE_REUSE_TOKEN = "reuse-token";
    privateEnv.PREVIEW_GOVERNANCE_DISPATCH_TOKEN = "governance-dispatch-token";
    privateEnv.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN = "";
    privateEnv.PREVIEW_CONTROL_CAPABILITY_TOKEN = "d".repeat(64);
  });

  it("accepts only the purpose-specific accepted-image reuse header", () => {
    const accepted = request({
      "x-preview-accepted-image-reuse": "reuse-token",
    });
    expect(validatePreviewAcceptedImageReuseToken(accepted)).toBe(true);
    expect(() => requirePreviewAcceptedImageReuse(accepted)).not.toThrow();

    const invalidReuseHeaders: Array<Record<string, string>> = [
      { "x-internal-token": "shared-token" },
      { "x-preview-control-broker-token": "reuse-token" },
      { authorization: "Bearer reuse-token" },
      { "x-preview-accepted-image-reuse": "wrong-token" },
    ];
    for (const headers of invalidReuseHeaders) {
      const candidate = request(headers);
      expect(validatePreviewAcceptedImageReuseToken(candidate)).toBe(false);
      expect(() => requirePreviewAcceptedImageReuse(candidate)).toThrow();
    }
  });

  it("isolates activation dispatch from broad internal and broker credentials", () => {
    const accepted = request({
      "x-preview-governance-dispatch": "governance-dispatch-token",
    });
    expect(validatePreviewGovernanceDispatchToken(accepted)).toBe(true);
    expect(() => requirePreviewGovernanceDispatch(accepted)).not.toThrow();

    const invalidHeaders: Array<Record<string, string>> = [
      { "x-internal-token": "shared-token" },
      { "x-preview-control-broker-token": "governance-dispatch-token" },
      { authorization: "Bearer governance-dispatch-token" },
      { "x-preview-governance-dispatch": "wrong-token" },
    ];
    for (const headers of invalidHeaders) {
      const candidate = request(headers);
      expect(validatePreviewGovernanceDispatchToken(candidate)).toBe(false);
      expect(() => requirePreviewGovernanceDispatch(candidate)).toThrow();
    }
  });

  it("isolates the physical broker token from both existing credentials", () => {
    expect(
      validatePreviewControlBrokerToken(
        request({ "x-preview-control-broker-token": "broker-token" }),
      ),
    ).toBe(true);
    const invalidHeaders: Array<Record<string, string>> = [
      { "x-internal-token": "shared-token" },
      { "x-preview-action-token": "preview-token" },
      { authorization: "Bearer broker-token" },
    ];
    for (const headers of invalidHeaders) {
      const candidate = request(headers);
      expect(validatePreviewControlBrokerToken(candidate)).toBe(false);
      expect(() => requirePreviewControlBroker(candidate)).toThrow();
    }
  });

  it("does not accept the broad internal token on the preview action path", () => {
    const shared = request({ "x-internal-token": "shared-token" });
    expect(validateInternalToken(shared)).toBe(true);
    expect(validatePreviewActionInternalToken(shared)).toBe(false);
    try {
      requirePreviewActionInternal(shared);
      expect.unreachable("shared internal token must be rejected");
    } catch (cause) {
      expect((cause as { status?: number }).status).toBe(401);
    }
  });

  it("accepts only the purpose-bound Drasi credential", () => {
    expect(
      validateDrasiIncidentIngestToken(
        request({ authorization: "Bearer drasi-token" }),
      ),
    ).toBe(true);
    expect(
      validateDrasiIncidentIngestToken(
        request({ "x-drasi-incident-token": "drasi-token" }),
      ),
    ).toBe(true);
    expect(
      validateDrasiIncidentIngestToken(
        request({ "x-internal-token": "shared-token" }),
      ),
    ).toBe(false);
    expect(
      validateDrasiIncidentIngestToken(
        request({ authorization: "Bearer shared-token" }),
      ),
    ).toBe(false);
  });

  it("accepts only the dedicated preview action header", () => {
    const preview = request({ "x-preview-action-token": "preview-token" });
    expect(validatePreviewActionInternalToken(preview)).toBe(true);
    expect(() => requirePreviewActionInternal(preview)).not.toThrow();
  });

  it("fails closed when the dedicated credential is absent", () => {
    privateEnv.PREVIEW_ACTION_INTERNAL_TOKEN = "";
    expect(
      validatePreviewActionInternalToken(
        request({ "x-preview-action-token": "preview-token" }),
      ),
    ).toBe(false);
  });

  it("accepts the tuple-bound local leaf only on explicit read guards", () => {
    const leaf = request({
      "x-preview-control-capability": "d".repeat(64),
    });
    expect(validateInternalToken(leaf)).toBe(false);
    expect(validateInternalOrPreviewControlRead(leaf)).toBe(true);
    expect(
      validateInternalOrPreviewControlRead(
        request({ "x-preview-control-capability": "e".repeat(64) }),
      ),
    ).toBe(false);
  });

  it.each([
    ["request", { environmentRequestId: "request-2" }],
    ["platform", { environmentPlatformRevision: "e".repeat(40) }],
    ["source", { environmentSourceRevision: "f".repeat(40) }],
    ["catalog", { catalogDigest: `sha256:${"9".repeat(64)}` }],
  ])("rejects a capability minted for the wrong %s tuple", (_field, change) => {
    const root = "1".repeat(64);
    privateEnv.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN = root;
    const identity = {
      previewName: "feature-one",
      environmentRequestId: "request-1",
      environmentPlatformRevision: "a".repeat(40),
      environmentSourceRevision: "b".repeat(40),
      catalogDigest: `sha256:${"c".repeat(64)}`,
      ...change,
    } as PreviewControlIdentity;
    const token = derivePreviewControlCapability(root, identity);
    const candidate = request({
      "x-preview-control-capability": token,
    });

    expect(validateInternalOrPreviewControlRead(candidate)).toBe(false);
    try {
      requireInternalOrPreviewControlRead(candidate);
      expect.unreachable("a wrong-tuple capability must be rejected");
    } catch (cause) {
      expect((cause as { status?: number }).status).toBe(401);
    }
  });
});
