"use client";

import { Bot, Database, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePiecesCatalog } from "@/lib/actions/pieces-store";

interface IntegrationIconProps {
  integration: string;
  className?: string;
  logoUrl?: string;
}

// Inline SVG for Vercel icon (special case - no plugin)
function VercelIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="currentColor"
      height="12"
      viewBox="0 0 1155 1000"
      width="12"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="m577.3 0 577.4 1000H0z" />
    </svg>
  );
}

// Special icons for integrations without plugins (database, vercel)
const SPECIAL_ICONS: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  database: Database,
  durable: Bot,
  vercel: VercelIcon,
};

export function IntegrationIcon({
  integration,
  className = "h-3 w-3",
  logoUrl,
}: IntegrationIconProps) {
  const { getIntegration } = usePiecesCatalog();

  // Check for special icons first (integrations without plugins)
  const SpecialIcon = SPECIAL_ICONS[integration];
  if (SpecialIcon) {
    return <SpecialIcon className={cn("text-foreground", className)} />;
  }

  const piece = getIntegration(integration);
  const resolvedLogoUrl = logoUrl || piece?.logoUrl;

  // Fallback to logoUrl for Activepieces pieces
  if (resolvedLogoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        alt={integration}
        className={cn("object-contain", className)}
        src={resolvedLogoUrl}
      />
    );
  }

  // Fallback for unknown integrations
  return <HelpCircle className={cn("text-foreground", className)} />;
}
