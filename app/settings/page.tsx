"use client";

import Link from "next/link";
import {
	ArrowRight,
	SlidersHorizontal,
	PlugZap,
	Blocks,
	KeyRound,
} from "lucide-react";
import { SettingsSubnav } from "@/components/settings/settings-subnav";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";

const links = [
	{
		href: "/settings/runtime-config",
		label: "Runtime Config",
		description:
			"Read and update dynamic Dapr-backed configuration values used by agents and workflows.",
		icon: SlidersHorizontal,
	},
	{
		href: "/settings/oauth-apps",
		label: "OAuth Apps",
		description: "Configure provider client IDs/secrets used by integrations.",
		icon: KeyRound,
	},
	{
		href: "/settings/mcp",
		label: "MCP Servers",
		description: "Manage MCP server templates and service-level defaults.",
		icon: Blocks,
	},
	{
		href: "/settings/mcp-connections",
		label: "MCP Connections",
		description: "Manage project-level MCP connections and health.",
		icon: PlugZap,
	},
];

export default function SettingsPage() {
	return (
		<div className="pointer-events-auto flex h-full flex-col bg-background">
			<div className="flex items-center gap-2 border-b px-6 py-4">
				<SidebarToggle />
				<div>
					<h1 className="font-semibold text-xl">Settings</h1>
					<p className="text-muted-foreground text-sm">
						Service and platform configuration for workflow execution.
					</p>
				</div>
			</div>
			<SettingsSubnav />
			<div className="flex-1 overflow-auto p-6">
				<div className="grid gap-4 md:grid-cols-2">
					{links.map((item) => (
						<Link
							className="rounded-lg border bg-card p-4 transition-colors hover:bg-muted/40"
							href={item.href}
							key={item.href}
						>
							<div className="mb-3 flex items-center justify-between">
								<div className="flex items-center gap-2">
									<item.icon className="size-4 text-muted-foreground" />
									<h2 className="font-medium text-sm">{item.label}</h2>
								</div>
								<ArrowRight className="size-4 text-muted-foreground" />
							</div>
							<p className="text-muted-foreground text-xs leading-relaxed">
								{item.description}
							</p>
						</Link>
					))}
				</div>
				<div className="mt-6 rounded-lg border bg-muted/20 p-4">
					<div className="mb-2 font-medium text-sm">Quick Path</div>
					<p className="text-muted-foreground text-xs">
						For agent runtime tuning, use Runtime Config first, then open your
						workflow and run it to verify changes.
					</p>
					<div className="mt-3 flex gap-2">
						<Button asChild size="sm" variant="outline">
							<Link href="/settings/runtime-config">Open Runtime Config</Link>
						</Button>
						<Button asChild size="sm" variant="outline">
							<Link href="/workflows">Back to Builder</Link>
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
