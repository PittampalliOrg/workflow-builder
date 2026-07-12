export function resolvePreviewLaunchOrigin(
  configuredOrigin: string | null | undefined,
  browserOrigin: string | null | undefined,
): string | null {
  const currentOrigin = browserOrigin?.trim();
  if (currentOrigin) return currentOrigin;

  const fallbackOrigin = configuredOrigin?.trim();
  return fallbackOrigin || null;
}
