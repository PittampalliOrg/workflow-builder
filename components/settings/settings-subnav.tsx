"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const items = [
	{ href: "/settings/oauth-apps", label: "OAuth Apps" },
	{ href: "/settings/mcp", label: "MCP" },
	{ href: "/settings/mcp-connections", label: "MCP Connections" },
];

export function SettingsSubnav() {
	const pathname = usePathname();

	return (
		<div className="flex gap-2 border-b px-6 py-2">
			{items.map((item) => {
				const active =
					pathname === item.href || pathname.startsWith(`${item.href}/`);
				return (
					<Link
						className={cn(
							"rounded-md px-3 py-1.5 text-sm",
							active
								? "bg-muted text-foreground"
								: "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
						)}
						href={item.href}
						key={item.href}
					>
						{item.label}
					</Link>
				);
			})}
		</div>
	);
}
