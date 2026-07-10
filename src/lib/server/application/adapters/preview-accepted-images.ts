import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "$env/dynamic/private";
import { and, eq } from "drizzle-orm";
import type {
  PreviewAcceptedImageReceipt,
  PreviewAcceptedImageReceiptAttestationPort,
  PreviewAcceptedImageReceiptContent,
  PreviewAcceptedImageReceiptLookup,
  PreviewAcceptedImageReceiptStorePort,
  PreviewAcceptedImageSubject,
} from "$lib/server/application/ports";
import {
  preparePreviewAcceptedImageReceipt,
  stablePreviewReceiptJson,
} from "$lib/server/application/preview-accepted-images";
import { db as defaultDb } from "$lib/server/db";
import { previewAcceptedImageReceipts } from "$lib/server/db/schema";

type Database = typeof defaultDb;
const ROOT = /^[a-f0-9]{64}$/;
const ATTESTATION = /^v1\.[a-f0-9]{64}$/;

/** HMAC provenance held only by the physical broker, separate from database authority. */
export class HmacPreviewAcceptedImageReceiptAttestationAdapter implements PreviewAcceptedImageReceiptAttestationPort {
  constructor(
    private readonly root: () => string = () =>
      (
        env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
        process.env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
        ""
      ).trim(),
  ) {}

  attest(input: PreviewAcceptedImageReceiptContent): `v1.${string}` {
    const prepared = preparePreviewAcceptedImageReceipt(input);
    if (prepared.receiptDigest !== input.receiptDigest) {
      throw new Error("accepted image receipt digest is invalid");
    }
    const root = this.root();
    if (!ROOT.test(root)) {
      throw new Error("accepted image receipt attestation root is invalid");
    }
    const key = createHmac("sha256", Buffer.from(root, "hex"))
      .update("preview-accepted-image-receipt-attestation-v1")
      .digest();
    return `v1.${createHmac("sha256", key)
      .update(stablePreviewReceiptJson(prepared))
      .digest("hex")}`;
  }

  verify(input: PreviewAcceptedImageReceipt): boolean {
    if (!ATTESTATION.test(input.attestation)) return false;
    try {
      const prepared = preparePreviewAcceptedImageReceipt(input);
      if (prepared.receiptDigest !== input.receiptDigest) return false;
      const expected = this.attest(prepared);
      const actualBytes = Buffer.from(input.attestation);
      const expectedBytes = Buffer.from(expected);
      return (
        actualBytes.length === expectedBytes.length &&
        timingSafeEqual(actualBytes, expectedBytes)
      );
    } catch {
      return false;
    }
  }
}

/** Postgres adapter for immutable, broker-attested acceptance evidence. */
export class PostgresPreviewAcceptedImageReceiptStore implements PreviewAcceptedImageReceiptStorePort {
  constructor(
    private readonly database: Database = defaultDb,
    private readonly attestations: PreviewAcceptedImageReceiptAttestationPort = new HmacPreviewAcceptedImageReceiptAttestationAdapter(),
  ) {}

  async put(
    input: Parameters<PreviewAcceptedImageReceiptStorePort["put"]>[0],
  ): Promise<PreviewAcceptedImageReceipt> {
    const prepared = preparePreviewAcceptedImageReceipt(input);
    const attestation = this.attestations.attest(prepared);
    const lookup = receiptLookup(prepared);
    const existing = await this.getByRepoPrHeadContext(lookup);
    if (existing)
      return assertSameReceipt(
        existing,
        prepared,
        attestation,
        this.attestations,
      );

    const inserted = await this.database
      .insert(previewAcceptedImageReceipts)
      .values({
        receiptDigest: prepared.receiptDigest,
        repository: prepared.repository,
        pullRequestNumber: prepared.pullRequestNumber,
        baseSha: prepared.baseSha,
        headSha: prepared.headSha,
        catalogDigest: prepared.catalogDigest,
        context: prepared.context,
        subjects: prepared.subjects.map((subject) => ({ ...subject })),
        attestation,
      })
      .onConflictDoNothing()
      .returning({ receiptDigest: previewAcceptedImageReceipts.receiptDigest });
    const stored = await this.getByRepoPrHeadContext(lookup);
    if (!stored) {
      throw new Error("accepted image receipt insert was not observable");
    }
    if (
      inserted.length === 1 &&
      inserted[0]?.receiptDigest !== prepared.receiptDigest
    ) {
      throw new Error(
        "accepted image receipt insert returned a different digest",
      );
    }
    return assertSameReceipt(stored, prepared, attestation, this.attestations);
  }

  async getByRepoPrHeadContext(
    input: PreviewAcceptedImageReceiptLookup,
  ): Promise<PreviewAcceptedImageReceipt | null> {
    const [row] = await this.database
      .select()
      .from(previewAcceptedImageReceipts)
      .where(
        and(
          eq(previewAcceptedImageReceipts.repository, input.repository),
          eq(
            previewAcceptedImageReceipts.pullRequestNumber,
            input.pullRequestNumber,
          ),
          eq(previewAcceptedImageReceipts.baseSha, input.baseSha),
          eq(previewAcceptedImageReceipts.headSha, input.headSha),
          eq(previewAcceptedImageReceipts.context, input.context),
        ),
      )
      .limit(1);
    if (!row) return null;
    const receipt = mapReceipt(row);
    if (!this.attestations.verify(receipt)) {
      throw new Error("accepted image receipt attestation is invalid");
    }
    return receipt;
  }
}

function mapReceipt(
  row: typeof previewAcceptedImageReceipts.$inferSelect,
): PreviewAcceptedImageReceipt {
  return Object.freeze({
    repository: row.repository,
    pullRequestNumber: row.pullRequestNumber,
    baseSha: row.baseSha as PreviewAcceptedImageReceipt["baseSha"],
    headSha: row.headSha as PreviewAcceptedImageReceipt["headSha"],
    catalogDigest:
      row.catalogDigest as PreviewAcceptedImageReceipt["catalogDigest"],
    context: row.context as PreviewAcceptedImageReceipt["context"],
    subjects: Object.freeze(
      (row.subjects as PreviewAcceptedImageSubject[]).map((subject) =>
        Object.freeze({ ...subject }),
      ),
    ),
    receiptDigest:
      row.receiptDigest as PreviewAcceptedImageReceipt["receiptDigest"],
    attestation: row.attestation as PreviewAcceptedImageReceipt["attestation"],
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : new Date(row.createdAt).toISOString(),
  });
}

function receiptLookup(
  input: Parameters<typeof preparePreviewAcceptedImageReceipt>[0],
): PreviewAcceptedImageReceiptLookup {
  return {
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    baseSha: input.baseSha,
    headSha: input.headSha,
    context: input.context,
  };
}

function assertSameReceipt(
  stored: PreviewAcceptedImageReceipt,
  prepared: ReturnType<typeof preparePreviewAcceptedImageReceipt>,
  attestation: `v1.${string}`,
  attestations: PreviewAcceptedImageReceiptAttestationPort,
): PreviewAcceptedImageReceipt {
  const storedContent = {
    repository: stored.repository,
    pullRequestNumber: stored.pullRequestNumber,
    baseSha: stored.baseSha,
    headSha: stored.headSha,
    catalogDigest: stored.catalogDigest,
    context: stored.context,
    subjects: stored.subjects,
    receiptDigest: stored.receiptDigest,
  };
  if (
    !attestations.verify(stored) ||
    stored.attestation !== attestation ||
    stored.receiptDigest !== prepared.receiptDigest ||
    stablePreviewReceiptJson(storedContent) !==
      stablePreviewReceiptJson(prepared)
  ) {
    throw new Error(
      "immutable accepted image receipt tuple was replayed with different content",
    );
  }
  return stored;
}
