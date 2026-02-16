"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
	Workflow,
	Activity,
	Bot,
	Plug,
	ChevronRight,
	PenTool,
	Settings,
	AppWindow,
	MessageSquare,
	Eye,
} from "lucide-react";
import { SidebarUserNav } from "@/components/sidebar-user-nav";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarMenu,
	SidebarMenuItem,
	SidebarMenuButton,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarGroupContent,
	SidebarRail,
	useSidebar,
} from "@/components/ui/sidebar";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { User } from "@/lib/db/schema";

const navigationLinks = [
	{ href: "/", label: "Builder", icon: PenTool },
	{ href: "/monitor", label: "Monitor", icon: Activity },
	{ href: "/observability", label: "Observability", icon: Eye },
	{ href: "/agents", label: "Agents", icon: Bot },
	{ href: "/connections", label: "Connections", icon: Plug },
	{ href: "/mcp-apps", label: "MCP Apps", icon: AppWindow },
	{ href: "/mcp-chat", label: "MCP Chat", icon: MessageSquare },
	{ href: "/settings", label: "Settings", icon: Settings },
];

export function AppSidebar({ user }: { user: User | undefined }) {
	const pathname = usePathname();
	const { setOpenMobile } = useSidebar();
	const [workflowsOpen, setWorkflowsOpen] = useState(true);

	const isActiveLink = (href: string) => {
		if (href === "/") {
			// Builder is active on home page or any /workflows/* page
			return pathname === "/" || pathname.startsWith("/workflows");
		}
		return pathname === href || pathname.startsWith(href + "/");
	};

	return (
		<Sidebar collapsible="icon" className="group-data-[side=left]:border-r-0">
			<SidebarContent>
				{/* Navigation Section (Collapsible) */}
				<Collapsible open={workflowsOpen} onOpenChange={setWorkflowsOpen}>
					<SidebarGroup>
						<CollapsibleTrigger asChild>
							<SidebarGroupLabel className="cursor-pointer hover:bg-muted/50 rounded-md -mx-2 px-2 flex items-center justify-between text-xs uppercase text-muted-foreground">
								<div className="flex items-center gap-2">
									<Workflow className="h-3 w-3" />
									<span>Workflows</span>
								</div>
								<ChevronRight
									className={cn(
										"h-4 w-4 transition-transform duration-200",
										workflowsOpen && "rotate-90",
									)}
								/>
							</SidebarGroupLabel>
						</CollapsibleTrigger>
						<CollapsibleContent>
							<SidebarGroupContent>
								<SidebarMenu>
									{navigationLinks.map((link) => (
										<SidebarMenuItem key={link.href}>
											<SidebarMenuButton
												asChild
												isActive={isActiveLink(link.href)}
												tooltip={link.label}
											>
												<Link
													href={link.href}
													onClick={() => setOpenMobile(false)}
												>
													<link.icon className="h-4 w-4" />
													<span>{link.label}</span>
												</Link>
											</SidebarMenuButton>
										</SidebarMenuItem>
									))}
								</SidebarMenu>
							</SidebarGroupContent>
						</CollapsibleContent>
					</SidebarGroup>
				</Collapsible>
			</SidebarContent>

			<SidebarFooter>{user && <SidebarUserNav user={user} />}</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}
