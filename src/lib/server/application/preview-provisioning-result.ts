import type { DevPreviewsResult } from "$lib/server/application/ports";

const MAX_FAILURES = 5;
const MAX_SERVICE_LENGTH = 80;
const MAX_DETAIL_LENGTH = 240;
const MAX_SUMMARY_LENGTH = 1_600;

function oneLine(value: string, fallback: string, maxLength: number): string {
  const normalized = value.replace(/[\r\n]+/g, " ").trim();
  return (normalized || fallback).slice(0, maxLength);
}

export function withDevPreviewFailureSummary(
  result: DevPreviewsResult,
): DevPreviewsResult | (DevPreviewsResult & { error: string }) {
  if (result.ok) return result;
  const failed = result.services
    .filter((service) => !service.ok)
    .slice(0, MAX_FAILURES)
    .map((service) => {
      const label = oneLine(
        service.service,
        "unknown-service",
        MAX_SERVICE_LENGTH,
      );
      const detail = oneLine(
        service.error || "",
        "not ready",
        MAX_DETAIL_LENGTH,
      );
      return `${label}: ${detail}`;
    });
  const summary = failed.length
    ? `dev-preview provision failed: ${failed.join("; ")}`
    : "dev-preview provision failed without a service result";
  return { ...result, error: summary.slice(0, MAX_SUMMARY_LENGTH) };
}
