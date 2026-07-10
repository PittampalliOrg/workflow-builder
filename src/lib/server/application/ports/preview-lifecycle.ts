export type PreviewArchiveResult = Readonly<{
  archived: boolean;
  preview: string;
  reason?: string;
  summaryFileId?: string;
  executionCount?: number;
  bundleCount?: number;
  bundleErrors?: number;
  notes?: string[];
  quarantined?: boolean;
}>;

export type PreviewArchiveInput = Readonly<{
  name: string;
  userId: string;
  projectId?: string | null;
}>;

export type PreviewArchiveQuarantineInput = Readonly<{
  preview: Readonly<{
    name: string;
    pool: string | null;
    url: string | null;
    expiresAt: string;
  }>;
  userId: string;
  projectId?: string | null;
  reason: string;
  forcedAt: string;
  graceExpiredAt: string;
  attemptedArchive: PreviewArchiveResult | null;
}>;

/** Host-side durability boundary used by lifecycle policy before destructive teardown. */
export interface PreviewArchivePort {
  archivePreview(input: PreviewArchiveInput): Promise<PreviewArchiveResult>;
  quarantinePreview(
    input: PreviewArchiveQuarantineInput,
  ): Promise<PreviewArchiveResult>;
}
