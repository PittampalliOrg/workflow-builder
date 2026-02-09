"use client";

import {
  Activity,
  ChevronRight,
  PenTool,
  Plug,
  Plus,
  Settings,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { SidebarUserNav } from "@/components/sidebar-user-nav";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import type { User } from "@/lib/db/schema";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const navigationLinks = [
  { href: "/", label: "Builder", icon: PenTool },
  { href: "/monitor", label: "Monitor", icon: Activity },
  { href: "/connections", label: "Connections", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppSidebar({ user }: { user: User | undefined }) {
  const router = useRouter();
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const [workflowsOpen, setWorkflowsOpen] = useState(true);

  const isActiveLink = (href: string) => {
    if (href === "/") {
      // Builder is active on home page or any /workflows/* page
      return pathname === "/" || pathname.startsWith("/workflows");
    }
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <Sidebar className="group-data-[side=left]:border-r-0">
      <SidebarHeader>
        <SidebarMenu>
          <div className="flex flex-row items-center justify-between">
            <Link
              className="flex flex-row items-center gap-3"
              href="/"
              onClick={() => {
                setOpenMobile(false);
              }}
            >
              <span className="cursor-pointer rounded-md px-2 font-semibold text-lg hover:bg-muted">
                Workflow Builder
              </span>
            </Link>
            <div className="flex flex-row gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    className="h-8 p-1 md:h-fit md:p-2"
                    onClick={() => {
                      setOpenMobile(false);
                      router.push("/");
                      router.refresh();
                    }}
                    type="button"
                    variant="ghost"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent align="end" className="hidden md:block">
                  New Workflow
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {/* Navigation Section (Collapsible) */}
        <Collapsible onOpenChange={setWorkflowsOpen} open={workflowsOpen}>
          <SidebarGroup>
            <CollapsibleTrigger asChild>
              <SidebarGroupLabel className="-mx-2 flex cursor-pointer items-center justify-between rounded-md px-2 text-muted-foreground text-xs uppercase hover:bg-muted/50">
                <div className="flex items-center gap-2">
                  <Workflow className="h-3 w-3" />
                  <span>Workflows</span>
                </div>
                <ChevronRight
                  className={cn(
                    "h-4 w-4 transition-transform duration-200",
                    workflowsOpen && "rotate-90"
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
    </Sidebar>
  );
}
