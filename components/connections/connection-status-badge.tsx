"use client";

import { AppConnectionStatus } from "@/lib/types/app-connection";
import { cn } from "@/lib/utils";

const statusConfig: Record<
  AppConnectionStatus,
  { label: string; dotClass: string; textClass: string }
> = {
  [AppConnectionStatus.ACTIVE]: {
    label: "Active",
    dotClass: "bg-green-500",
    textClass: "text-green-700 dark:text-green-400",
  },
  [AppConnectionStatus.ERROR]: {
    label: "Error",
    dotClass: "bg-red-500",
    textClass: "text-red-700 dark:text-red-400",
  },
  [AppConnectionStatus.MISSING]: {
    label: "Missing",
    dotClass: "bg-yellow-500",
    textClass: "text-yellow-700 dark:text-yellow-400",
  },
};

export function ConnectionStatusBadge({
  status,
}: {
  status: AppConnectionStatus;
}) {
  const config =
    statusConfig[status] ?? statusConfig[AppConnectionStatus.MISSING];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-medium text-xs",
        config.textClass
      )}
    >
      <span className={cn("h-2 w-2 rounded-full", config.dotClass)} />
      {config.label}
    </span>
  );
}
