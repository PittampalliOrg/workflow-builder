"use client";

import { SidebarToggle } from "@/components/sidebar-toggle";
import { ConnectionsTable } from "@/components/connections/connections-table";

export default function ConnectionsPage() {
  return (
    <div className="pointer-events-auto flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b px-6 py-4">
        <SidebarToggle />
        <div>
          <h1 className="text-xl font-semibold">Connections</h1>
          <p className="text-sm text-muted-foreground">
            Manage your app connections and credentials
          </p>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-6">
        <ConnectionsTable />
      </div>
    </div>
  );
}
