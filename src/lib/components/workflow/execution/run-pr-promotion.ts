/**
 * Client-side adapter for the "Create PR" action on the run Changes tab.
 *
 * Determines whether a plain run can open a GitHub pull request from its
 * captured code, using the GENERIC (non-preview) promotion lane:
 *
 *   GET  /api/workflows/executions/{id}/versions
 *   POST /api/workflows/executions/{id}/versions/{artifactId}/promote { mode:'pr' }
 *
 * The server (`workflowCodeVersionPromotion.promote`) opens a real PR by
 * provisioning a helper pod — it needs a `source-bundle` version with a blob,
 * a resolvable target repo (from the version payload or the execution input),
 * and a passing promotion gate. It is NOT tied to a preview vCluster or the
 * control broker. STRICT preview captures (atomic tar-overlay-set) are rejected
 * by that lane (409) and must be promoted from the dev environment detail page
 * through preview continuation instead.
 *
 * This module is pure (no I/O for the selection logic) so the decision table is
 * unit-tested directly by `run-pr-promotion.test.ts`; `runVersionPromotion`
 * wraps the single POST for the component.
 */

export type CodeVersionPromotionGate = {
  required: boolean;
  allowed: boolean;
  reason: string;
};

export type CodeVersionRecord = {
  artifactId: string;
  fileId: string | null;
  payload: unknown;
  promotionGate?: CodeVersionPromotionGate | null;
  promotion: unknown;
  createdAt: string;
};

/** A `source-bundle` version whose payload is a strict atomic preview capture. */
function isStrictPreviewVersion(version: CodeVersionRecord): boolean {
  const payload = asRecord(version.payload);
  return (
    payload.tier === "tar-overlay-set" &&
    (payload.captureProtocol === "atomic-generation-v2" ||
      payload.acceptanceEligible === true)
  );
}

/** Extract a github.com PR url from a stored promotion record, if any. */
export function pullRequestUrlFromPromotion(promotion: unknown): string | null {
  const record = asRecord(promotion);
  const direct = readNonEmptyString(record.prUrl);
  if (direct) return direct;
  const pullRequest = asRecord(record.pullRequest);
  const repository =
    readNonEmptyString(record.repository) ?? readNonEmptyString(pullRequest.repository);
  const number =
    typeof record.pullRequestNumber === "number"
      ? record.pullRequestNumber
      : typeof pullRequest.number === "number"
        ? pullRequest.number
        : null;
  if (repository && number && Number.isSafeInteger(number) && number > 0) {
    return `https://github.com/${repository}/pull/${number}`;
  }
  return null;
}

export type RunPromotionSelection =
  /** The newest legacy source-bundle version is ready to open a PR. */
  | { status: "ready"; artifactId: string }
  /** The newest legacy version already has a PR — offer to view it. */
  | { status: "already-promoted"; artifactId: string; prUrl: string }
  /** Source bundles exist but the promotion gate blocks a PR. */
  | { status: "gate-blocked"; artifactId: string; reason: string }
  /** Only strict preview captures exist — promote from the dev detail page. */
  | { status: "strict-only" }
  /** No promotable source-bundle version was captured for this run. */
  | { status: "none" };

/**
 * Decide the run-level "Create PR" action from the versions list. Chooses the
 * newest LEGACY (non-strict) source-bundle version, because that is the one the
 * generic promote lane can open a PR from.
 */
export function selectRunPromotion(
  versions: readonly CodeVersionRecord[],
): RunPromotionSelection {
  const legacy = versions
    .filter((version) => !isStrictPreviewVersion(version))
    .sort((a, b) => versionTime(b) - versionTime(a));

  if (legacy.length === 0) {
    return versions.length > 0 ? { status: "strict-only" } : { status: "none" };
  }

  const newest = legacy[0];
  const existingPr = pullRequestUrlFromPromotion(newest.promotion);
  if (existingPr) {
    return { status: "already-promoted", artifactId: newest.artifactId, prUrl: existingPr };
  }
  if (!newest.fileId) {
    return {
      status: "gate-blocked",
      artifactId: newest.artifactId,
      reason: "source_bundle_unavailable",
    };
  }
  const gate = newest.promotionGate;
  if (gate && gate.required && !gate.allowed) {
    return { status: "gate-blocked", artifactId: newest.artifactId, reason: gate.reason };
  }
  return { status: "ready", artifactId: newest.artifactId };
}

export type CreatePrButtonState = {
  /** "create" enables the promote POST; "view" links to an existing PR. */
  action: "create" | "view" | "none";
  label: string;
  disabled: boolean;
  /** Tooltip explaining a disabled state, or null when actionable. */
  tooltip: string | null;
  prUrl: string | null;
  artifactId: string | null;
};

const GATE_REASON_COPY: Record<string, string> = {
  source_bundle_unavailable:
    "The captured source bundle for this run is unavailable, so a pull request cannot be opened.",
  accepted_false_or_missing:
    "This run's latest code version has not passed its acceptance gate, so it cannot be promoted to a pull request.",
  score_below_threshold:
    "This run's evaluation score is below the promotion threshold, so it cannot be opened as a pull request.",
  artifact_not_accepted_iteration:
    "This code version is not the accepted iteration, so it cannot be promoted to a pull request.",
};

/** Presentation state for the Changes-tab "Create PR" button. */
export function createPrButtonState(selection: RunPromotionSelection): CreatePrButtonState {
  switch (selection.status) {
    case "ready":
      return {
        action: "create",
        label: "Create PR",
        disabled: false,
        tooltip: null,
        prUrl: null,
        artifactId: selection.artifactId,
      };
    case "already-promoted":
      return {
        action: "view",
        label: "View PR",
        disabled: false,
        tooltip: "This run's latest code version is already open as a pull request.",
        prUrl: selection.prUrl,
        artifactId: selection.artifactId,
      };
    case "gate-blocked":
      return {
        action: "none",
        label: "Create PR",
        disabled: true,
        tooltip:
          GATE_REASON_COPY[selection.reason] ??
          "This run's latest code version cannot be promoted to a pull request yet.",
        prUrl: null,
        artifactId: selection.artifactId,
      };
    case "strict-only":
      return {
        action: "none",
        label: "Create PR",
        disabled: true,
        tooltip:
          "This run's captures are preview checkpoints — open a PR from the dev environment detail page.",
        prUrl: null,
        artifactId: null,
      };
    case "none":
      return {
        action: "none",
        label: "Create PR",
        disabled: true,
        tooltip:
          "No promotable source bundle was captured for this run, so there is nothing to open as a pull request.",
        prUrl: null,
        artifactId: null,
      };
  }
}

export type VersionPromotionOutcome =
  | { ok: true; prUrl: string | null; branch: string | null }
  | { ok: false; error: string };

/** Parse the promote endpoint's JSON body into a normalized outcome. */
export function parsePromotionResponse(
  ok: boolean,
  status: number,
  body: unknown,
): VersionPromotionOutcome {
  const record = asRecord(body);
  const prUrl = readNonEmptyString(record.prUrl) ?? pullRequestUrlFromPromotion(record);
  if (ok && record.ok !== false && prUrl) {
    return { ok: true, prUrl, branch: readNonEmptyString(record.branch) };
  }
  if (ok && record.ok !== false && readNonEmptyString(record.branch)) {
    return { ok: true, prUrl: null, branch: readNonEmptyString(record.branch) };
  }
  const error =
    readNonEmptyString(record.error) ??
    readNonEmptyString(record.message) ??
    readNonEmptyString(record.prError) ??
    `Promotion failed (${status})`;
  return { ok: false, error };
}

/** POST the promote request for one version and normalize the outcome. */
export async function runVersionPromotion(
  executionId: string,
  artifactId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VersionPromotionOutcome> {
  try {
    const res = await fetchImpl(
      `/api/workflows/executions/${executionId}/versions/${artifactId}/promote`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "pr" }),
      },
    );
    const body = await res.json().catch(() => ({}));
    return parsePromotionResponse(res.ok, res.status, body);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function versionTime(version: CodeVersionRecord): number {
  const value = new Date(version.createdAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
