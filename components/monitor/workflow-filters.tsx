"use client";

import { useState } from "react";
import { Check, Filter, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  WorkflowUIStatus,
  WorkflowFilters,
} from "@/lib/types/workflow-ui";
import { cn } from "@/lib/utils";

const ALL_STATUSES: WorkflowUIStatus[] = [
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "SUSPENDED",
  "TERMINATED",
];

interface WorkflowFiltersProps {
  filters: WorkflowFilters;
  onFiltersChange: (filters: WorkflowFilters) => void;
  availableAppIds?: string[];
}

export function WorkflowFilters({
  filters,
  onFiltersChange,
  availableAppIds = ["workflow-orchestrator"],
}: WorkflowFiltersProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [tempFilters, setTempFilters] = useState<WorkflowFilters>(filters);

  const handleSearchChange = (value: string) => {
    onFiltersChange({ ...filters, search: value || undefined });
  };

  const handleStatusToggle = (status: WorkflowUIStatus) => {
    const currentStatuses = tempFilters.status || [];
    const newStatuses = currentStatuses.includes(status)
      ? currentStatuses.filter((s) => s !== status)
      : [...currentStatuses, status];
    setTempFilters({
      ...tempFilters,
      status: newStatuses.length ? newStatuses : undefined,
    });
  };

  const handleAppIdChange = (value: string) => {
    setTempFilters({
      ...tempFilters,
      appId: value === "all" ? undefined : value,
    });
  };

  const handleClearAll = () => {
    setTempFilters({ search: filters.search });
  };

  const handleApply = () => {
    onFiltersChange({ ...tempFilters, search: filters.search });
    setPopoverOpen(false);
  };

  const handleCancel = () => {
    setTempFilters(filters);
    setPopoverOpen(false);
  };

  const activeFilterCount =
    (filters.status?.length || 0) + (filters.appId ? 1 : 0);

  return (
    <div className="flex items-center gap-3">
      {/* Search Input */}
      <div className="relative flex-1 max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search workflows..."
          value={filters.search || ""}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="pl-9"
        />
        {filters.search && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
            onClick={() => handleSearchChange("")}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>

      {/* Filters Popover */}
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="gap-2">
            <Filter className="h-4 w-4" />
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-1 rounded-full bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">
                {activeFilterCount}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80" align="end">
          <div className="space-y-4">
            {/* App ID Filter */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">App ID</Label>
              <Select
                value={tempFilters.appId || "all"}
                onValueChange={handleAppIdChange}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All apps" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All apps</SelectItem>
                  {availableAppIds.map((appId) => (
                    <SelectItem key={appId} value={appId}>
                      {appId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Status Filter - using toggle badges instead of checkboxes */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Status</Label>
              <div className="flex flex-wrap gap-2">
                {ALL_STATUSES.map((status) => {
                  const isSelected = tempFilters.status?.includes(status) || false;
                  return (
                    <Badge
                      key={status}
                      variant={isSelected ? "default" : "outline"}
                      className={cn(
                        "cursor-pointer select-none transition-colors",
                        isSelected && "bg-primary"
                      )}
                      onClick={() => handleStatusToggle(status)}
                    >
                      {isSelected && <Check className="h-3 w-3 mr-1" />}
                      {status}
                    </Badge>
                  );
                })}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between pt-2 border-t">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearAll}
                className="text-muted-foreground"
              >
                Clear all
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleCancel}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleApply}>
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
