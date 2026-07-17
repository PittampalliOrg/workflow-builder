export const meta = {
  name: "preview-development-lifecycle",
  description:
    "Provision an isolated app-live preview from the physical dev cluster, start its pinned automated GAN-style UI development workflow with the submitted intent, verify its draft PR receipt, and complete guarded teardown.",
  phases: [
    { title: "Provision" },
    { title: "Start development" },
    { title: "Observe" },
    { title: "Finalize" },
  ],
  launch: { surface: "dev-environment", target: "control-plane" },
  input: {
    type: "object",
    required: ["intent", "environmentName"],
    additionalProperties: false,
    properties: {
      intent: {
        type: "string",
        title: "Development task",
        minLength: 1,
        maxLength: 12000,
        description:
          "The initial task sent to the preview-local automated UI development workflow.",
      },
      environmentName: {
        type: "string",
        title: "Preview environment name",
        pattern: "^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$",
      },
      services: {
        type: "array",
        title: "Microservices to develop",
        minItems: 1,
        uniqueItems: true,
        items: { type: "string" },
        default: ["workflow-builder"],
      },
      ttlHours: {
        type: "integer",
        title: "Preview lifetime in hours",
        minimum: 2,
        maximum: 24,
        default: 8,
      },
      retainAfterCompletion: {
        type: "boolean",
        title: "Retain environment after completion",
        default: false,
      },
      retainOnFailure: {
        type: "boolean",
        title: "Retain environment after failure",
        default: false,
      },
    },
  },
};

const t = args ?? {};
const intent = typeof t.intent === "string" ? t.intent.trim() : "";
const environmentName =
  typeof t.environmentName === "string" ? t.environmentName.trim() : "";
const services =
  Array.isArray(t.services) && t.services.length > 0
    ? t.services
    : ["workflow-builder"];
const ttlHours = Number.isInteger(t.ttlHours) ? t.ttlHours : 8;
const retainAfterCompletion = t.retainAfterCompletion === true;
const retainOnFailure = t.retainOnFailure === true;

if (!intent) throw new Error("intent is required");
if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(environmentName)) {
  throw new Error("environmentName is invalid");
}
if (
  !services.every(
    (service) => typeof service === "string" && service.length > 0,
  )
) {
  throw new Error("services must be a non-empty list of service ids");
}
if (new Set(services).size !== services.length)
  throw new Error("services must be unique");
if (!Number.isInteger(ttlHours) || ttlHours < 2 || ttlHours > 24) {
  throw new Error("ttlHours must be an integer between 2 and 24");
}
function stateOf(value) {
  return String(value?.status ?? value?.phase ?? "")
    .trim()
    .toLowerCase();
}

function failureOf(value) {
  if (value?.ok === false)
    return String(value.error ?? value.message ?? "operation failed");
  const state = stateOf(value);
  if (["failed", "error", "blocked", "cancelled"].includes(state)) {
    return String(
      value?.error ?? value?.message ?? `operation entered ${state}`,
    );
  }
  return "";
}

function errorMessage(error) {
  return error && typeof error.message === "string"
    ? error.message
    : String(error);
}

function transientPreviewWorkflowError(slug, error) {
  if (
    slug !== "preview/workflow-start" &&
    slug !== "preview/workflow-status" &&
    slug !== "preview/workflow-signal"
  )
    return false;
  const message = errorMessage(error);
  return (
    message.includes("preview development endpoint returned HTTP 409") ||
    message.includes("preview development endpoint returned HTTP 425") ||
    message.includes("preview development endpoint returned HTTP 502") ||
    message.includes("preview development request timed out")
  );
}

async function startPreviewWorkflow(input) {
  const attempts = 25;
  const pollSeconds = 5;
  let transientFailures = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await action("preview/workflow-start", input, {
        label: `start preview development workflow ${attempt + 1}`,
      });
      const failure = failureOf(result);
      if (failure) throw new Error(`preview/workflow-start: ${failure}`);
      return result;
    } catch (error) {
      if (
        transientPreviewWorkflowError("preview/workflow-start", error) &&
        transientFailures < attempts - 1
      ) {
        transientFailures += 1;
        if (attempt + 1 < attempts) await sleep(pollSeconds);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`preview/workflow-start timed out after ${attempts} attempts`);
}

async function waitForStatus(
  slug,
  input,
  isDone,
  label,
  attempts,
  pollSeconds,
  options = {},
) {
  let latest = null;
  let transientFailures = 0;
  const maxTransientFailures =
    Number.isInteger(options.maxTransientFailures) &&
    options.maxTransientFailures >= 0
      ? options.maxTransientFailures
      : slug === "preview/workflow-status"
        ? 24
        : 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      latest = await action(slug, input, { label: `${label} ${attempt + 1}` });
      transientFailures = 0;
    } catch (error) {
      if (
        transientPreviewWorkflowError(slug, error) &&
        transientFailures < maxTransientFailures
      ) {
        transientFailures += 1;
        if (attempt + 1 < attempts) await sleep(pollSeconds);
        continue;
      }
      throw error;
    }
    const failure = failureOf(latest);
    if (failure) throw new Error(`${slug}: ${failure}`);
    if (isDone(latest)) return latest;
    if (attempt + 1 < attempts) await sleep(pollSeconds);
  }
  throw new Error(`${slug} timed out after ${attempts} observations`);
}

async function signalPreviewWorkflow(input, actionName) {
  const label =
    actionName === "submit_preview_pr"
      ? "submit preview pull request"
      : "discard preview changes";
  const attempts = 25;
  const pollSeconds = 5;
  let transientFailures = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await action("preview/workflow-signal", input, {
        label: `${label} ${attempt + 1}`,
      });
      const failure = failureOf(result);
      if (failure) throw new Error(`preview/workflow-signal: ${failure}`);
      return result;
    } catch (error) {
      if (
        transientPreviewWorkflowError("preview/workflow-signal", error) &&
        transientFailures < attempts - 1
      ) {
        transientFailures += 1;
        if (attempt + 1 < attempts) await sleep(pollSeconds);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`preview/workflow-signal timed out after ${attempts} attempts`);
}

function environmentReady(value) {
  return value?.ready === true || stateOf(value) === "ready";
}

function childControlReady(value) {
  const state = stateOf(value);
  return (
    value?.controlReady === true ||
    value?.readyForControl === true ||
    state === "control-ready"
  );
}
function childFinished(value) {
  const state = stateOf(value);
  return (
    value?.complete === true ||
    value?.terminal === true ||
    ["completed", "discarded"].includes(state)
  );
}

function sameStringSet(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function assertChildOutcome(actionName, value, expected) {
  const output = value?.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("preview development child returned no terminal receipt");
  }
  if (actionName === "discard") {
    if (
      output.controlOutcome !== "discarded" ||
      output.pullRequest != null ||
      output.pullRequestReceipt != null
    ) {
      throw new Error("preview development discard was not durably confirmed");
    }
    return null;
  }

  const receipt = output.pullRequestReceipt ?? output.promotionReceipt;
  const pullRequest = receipt?.pullRequest;
  const expectedPrUrl =
    Number.isSafeInteger(pullRequest?.number) && pullRequest.number > 0
      ? `https://github.com/PittampalliOrg/workflow-builder/pull/${pullRequest.number}`
      : "";
  if (
    output.controlOutcome !== "submitted" ||
    receipt?.ok !== true ||
    receipt?.draft !== true ||
    typeof receipt.receiptId !== "string" ||
    receipt.receiptId.length < 1 ||
    receipt.receiptId.length > 256 ||
    receipt.previewName !== expected.target.previewName ||
    receipt.requestId !== expected.target.environmentRequestId ||
    receipt.executionId !== expected.executionId ||
    !sameStringSet(receipt.services, expected.services) ||
    typeof receipt.branch !== "string" ||
    receipt.branch.length < 1 ||
    receipt.branch.length > 256 ||
    typeof receipt.commitSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(receipt.commitSha) ||
    pullRequest?.repository !== "PittampalliOrg/workflow-builder" ||
    !Number.isSafeInteger(pullRequest?.number) ||
    pullRequest.number < 1 ||
    typeof pullRequest.baseSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(pullRequest.baseSha) ||
    typeof pullRequest.headSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(pullRequest.headSha) ||
    pullRequest.headSha !== receipt.commitSha ||
    pullRequest.baseSha === pullRequest.headSha ||
    receipt.prUrl !== expectedPrUrl
  ) {
    throw new Error(
      "preview development did not produce an authoritative draft pull request receipt",
    );
  }
  return receipt;
}

function sameTarget(left, right) {
  return (
    left?.previewName === right?.previewName &&
    left?.environmentRequestId === right?.environmentRequestId &&
    left?.platformRevision === right?.platformRevision &&
    left?.sourceRevision === right?.sourceRevision &&
    left?.catalogDigest === right?.catalogDigest
  );
}

function assertPromotionVerification(value, expected) {
  const receipt = value?.receipt;
  const pullRequest = receipt?.pullRequest;
  const expectedPrUrl =
    Number.isSafeInteger(pullRequest?.number) && pullRequest.number > 0
      ? `https://github.com/PittampalliOrg/workflow-builder/pull/${pullRequest.number}`
      : "";
  if (
    value?.kind !== "verify-promotion" ||
    value?.verified !== true ||
    value?.executionId !== expected.executionId ||
    !sameTarget(value?.target, expected.target) ||
    receipt?.ok !== true ||
    receipt?.receiptId !== expected.receiptId ||
    receipt?.previewName !== expected.target.previewName ||
    receipt?.requestId !== expected.target.environmentRequestId ||
    receipt?.executionId !== expected.executionId ||
    !sameStringSet(receipt?.services, expected.services) ||
    receipt?.draft !== true ||
    typeof receipt?.artifactId !== "string" ||
    receipt.artifactId.length < 1 ||
    typeof receipt?.branch !== "string" ||
    receipt.branch.length < 1 ||
    typeof receipt?.commitSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(receipt.commitSha) ||
    pullRequest?.repository !== "PittampalliOrg/workflow-builder" ||
    !Number.isSafeInteger(pullRequest?.number) ||
    pullRequest.number < 1 ||
    typeof pullRequest?.baseSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(pullRequest.baseSha) ||
    pullRequest?.headSha !== receipt.commitSha ||
    pullRequest.baseSha === pullRequest.headSha ||
    receipt?.prUrl !== expectedPrUrl
  ) {
    throw new Error(
      "physical preview promotion verification did not return the exact durable draft pull request receipt",
    );
  }
  return receipt;
}

function teardownFinished(value) {
  return (
    value?.complete === true ||
    value?.cleanup?.complete === true ||
    stateOf(value) === "complete"
  );
}

let environmentLaunched = false;
let launch = null;
let environment = null;
let child = null;
let outcome = null;
let promotionVerification = null;
let teardown = null;
let cleanup = null;
let completedNormally = false;

try {
  phase("Provision");
  launch = await action(
    "preview/environment-launch",
    {
      environmentName,
      services,
      ttlHours,
      retainAfterCompletion,
    },
    { label: "launch preview environment" },
  );
  const launchFailure = failureOf(launch);
  if (launchFailure)
    throw new Error(`preview/environment-launch: ${launchFailure}`);
  environmentLaunched = true;
  environment = await waitForStatus(
    "preview/environment-status",
    { target: launch?.target },
    environmentReady,
    "observe preview readiness",
    241,
    5,
  );

  phase("Start development");
  child = await startPreviewWorkflow({
    target: environment?.target ?? launch?.target,
    intent,
    services,
  });
  phase("Observe");
  outcome = await waitForStatus(
    "preview/workflow-status",
    {
      target: environment?.target ?? launch?.target,
      executionId: child?.executionId,
      workflowSpecDigest: child?.workflowSpecDigest,
    },
    childFinished,
    "observe development outcome",
    241,
    5,
    { maxTransientFailures: 240 },
  );
  const childPromotionReceipt = assertChildOutcome("submit_preview_pr", outcome, {
    target: environment?.target ?? launch?.target,
    executionId: child?.executionId,
    services,
  });
  promotionVerification = await action(
    "preview/workflow-verify-promotion",
    {
      target: environment?.target ?? launch?.target,
      childExecutionId: child?.executionId,
      receiptId: childPromotionReceipt?.receiptId,
      services,
    },
    { label: "verify physical promotion receipt" },
  );
  const verificationFailure = failureOf(promotionVerification);
  if (verificationFailure) {
    throw new Error(
      `preview/workflow-verify-promotion: ${verificationFailure}`,
    );
  }
  assertPromotionVerification(promotionVerification, {
    target: environment?.target ?? launch?.target,
    executionId: child?.executionId,
    receiptId: childPromotionReceipt?.receiptId,
    services,
  });
  completedNormally = true;
} finally {
  phase("Finalize");
  const shouldRetain =
    (completedNormally && retainAfterCompletion) ||
    (!completedNormally && retainOnFailure);
  if (environmentLaunched && !shouldRetain) {
    teardown = await action(
      "preview/environment-teardown",
      {
        target: environment?.target ?? launch?.target,
      },
      { label: "request preview teardown" },
    );
    const teardownFailure = failureOf(teardown);
    if (teardownFailure)
      throw new Error(`preview/environment-teardown: ${teardownFailure}`);
    if (teardownFinished(teardown)) {
      cleanup = teardown;
    } else if (teardown?.ticket) {
      cleanup = await waitForStatus(
        "preview/environment-teardown-status",
        {
          target: environment?.target ?? launch?.target,
          ticket: teardown.ticket,
        },
        teardownFinished,
        "observe preview cleanup",
        241,
        5,
      );
    } else {
      throw new Error(
        "preview/environment-teardown: cleanup is incomplete and no teardown ticket was returned",
      );
    }
  }
}

return {
  environmentName,
  services,
  retained:
    (completedNormally && retainAfterCompletion) ||
    (!completedNormally && retainOnFailure),
  retainedReason:
    completedNormally && retainAfterCompletion
      ? "completed"
      : !completedNormally && retainOnFailure
        ? "failure"
        : null,
  launch,
  environment,
  child,
  outcome,
  promotionVerification,
  teardown,
  cleanup,
};
