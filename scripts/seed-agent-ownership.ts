export type SeedAgentOwner = {
  userId: string;
  projectId: string | null;
};

export function assertSeedAgentOwnership(
  slug: string,
  existing: SeedAgentOwner | null,
  expected: SeedAgentOwner,
): void {
  if (
    existing &&
    (existing.userId !== expected.userId ||
      existing.projectId !== expected.projectId)
  ) {
    throw new Error(
      `Agent ${slug} already exists for user ${existing.userId} project ${existing.projectId ?? "null"}; set a targeted seed owner or move the existing agent first.`,
    );
  }
}
