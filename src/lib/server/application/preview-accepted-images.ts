import { createHash } from "node:crypto";
import type {
  PreviewAcceptedImageReceipt,
  PreviewAcceptedImageReceiptAttestationPort,
  PreviewAcceptedImageReceiptInput,
  PreviewAcceptedImageSubject,
  PreviewGateSubordinateContext,
} from "$lib/server/application/ports";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SUBJECT = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const BUILD_RUN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/;
const RECEIPT_CONTEXTS = new Set([
  "preview/immutable-acceptance",
  "preview/activation-images",
]);

export class PreviewAcceptedImageReceiptContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewAcceptedImageReceiptContractError";
  }
}

export type PreparedPreviewAcceptedImageReceipt =
  PreviewAcceptedImageReceiptInput &
    Readonly<{ receiptDigest: `sha256:${string}` }>;

export type PreviewAcceptedImageReceiptRequirement = Readonly<{
  repository: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  catalogDigest: `sha256:${string}`;
  context: PreviewGateSubordinateContext;
  subjects: readonly string[];
}>;

/** Validates and canonicalizes evidence before it crosses the durable-store port. */
export function preparePreviewAcceptedImageReceipt(
  input: PreviewAcceptedImageReceiptInput,
): PreparedPreviewAcceptedImageReceipt {
  if (
    !REPOSITORY.test(input.repository) ||
    !Number.isSafeInteger(input.pullRequestNumber) ||
    input.pullRequestNumber < 1 ||
    !FULL_SHA.test(input.baseSha) ||
    !FULL_SHA.test(input.headSha) ||
    input.baseSha === input.headSha ||
    !SHA256.test(input.catalogDigest) ||
    !RECEIPT_CONTEXTS.has(input.context)
  ) {
    throw new PreviewAcceptedImageReceiptContractError(
      "accepted image receipt tuple is invalid",
    );
  }
  if (!Array.isArray(input.subjects) || input.subjects.length === 0) {
    throw new PreviewAcceptedImageReceiptContractError(
      "accepted image receipt requires at least one subject",
    );
  }

  const names = new Set<string>();
  const subjects = input.subjects
    .map((subject) => validateSubject(subject, input.headSha))
    .sort((left, right) => left.subject.localeCompare(right.subject));
  for (const subject of subjects) {
    if (names.has(subject.subject)) {
      throw new PreviewAcceptedImageReceiptContractError(
        `accepted image receipt repeats subject ${subject.subject}`,
      );
    }
    names.add(subject.subject);
  }

  const canonical = Object.freeze({
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    baseSha: input.baseSha,
    headSha: input.headSha,
    catalogDigest: input.catalogDigest,
    context: input.context,
    subjects: Object.freeze(subjects),
  }) satisfies PreviewAcceptedImageReceiptInput;
  return Object.freeze({
    ...canonical,
    receiptDigest:
      `sha256:${createHash("sha256").update(stableJson(canonical)).digest("hex")}` as const,
  });
}

/** Revalidates durable evidence before a retry or aggregate gate trusts it. */
export function assertPreviewAcceptedImageReceiptRequirement(
  receipt: PreviewAcceptedImageReceipt,
  requirement: PreviewAcceptedImageReceiptRequirement,
  attestations: PreviewAcceptedImageReceiptAttestationPort,
): PreviewAcceptedImageReceipt {
  const prepared = preparePreviewAcceptedImageReceipt(receipt);
  const actualSubjects = prepared.subjects.map(({ subject }) => subject).sort();
  const expectedSubjects = [...requirement.subjects].sort();
  if (
    !attestations.verify(receipt) ||
    prepared.receiptDigest !== receipt.receiptDigest ||
    prepared.repository !== requirement.repository ||
    prepared.pullRequestNumber !== requirement.pullRequestNumber ||
    prepared.baseSha !== requirement.baseSha ||
    prepared.headSha !== requirement.headSha ||
    prepared.catalogDigest !== requirement.catalogDigest ||
    prepared.context !== requirement.context ||
    expectedSubjects.length === 0 ||
    new Set(expectedSubjects).size !== expectedSubjects.length ||
    JSON.stringify(actualSubjects) !== JSON.stringify(expectedSubjects)
  ) {
    throw new PreviewAcceptedImageReceiptContractError(
      "accepted image receipt does not match gate requirements",
    );
  }
  return receipt;
}

function validateSubject(
  input: PreviewAcceptedImageSubject,
  headSha: string,
): PreviewAcceptedImageSubject {
  if (
    !input ||
    typeof input !== "object" ||
    !SUBJECT.test(input.subject) ||
    input.sourceRevision !== headSha ||
    !BUILD_RUN.test(input.buildRun) ||
    !SHA256.test(input.digest)
  ) {
    throw new PreviewAcceptedImageReceiptContractError(
      "accepted image subject identity is invalid",
    );
  }
  const tagSeparator = input.imageRef.lastIndexOf(":");
  const pathSeparator = input.imageRef.lastIndexOf("/");
  if (
    tagSeparator <= pathSeparator ||
    input.imageRef.slice(tagSeparator + 1) !== `git-${headSha}`
  ) {
    throw new PreviewAcceptedImageReceiptContractError(
      `accepted image ${input.subject} is not tagged for the exact PR head`,
    );
  }
  const imageRepository = input.imageRef.slice(0, tagSeparator);
  if (
    !imageRepository.startsWith("ghcr.io/pittampalliorg/") ||
    input.immutableRef !== `${imageRepository}@${input.digest}`
  ) {
    throw new PreviewAcceptedImageReceiptContractError(
      `accepted image ${input.subject} has inconsistent immutable metadata`,
    );
  }
  return Object.freeze({
    subject: input.subject,
    sourceRevision: input.sourceRevision,
    buildRun: input.buildRun,
    imageRef: input.imageRef,
    digest: input.digest,
    immutableRef: input.immutableRef,
  });
}

export function stablePreviewReceiptJson(value: unknown): string {
  return stableJson(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
