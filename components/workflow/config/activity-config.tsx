"use client";

import { useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { TemplateBadgeTextarea } from "@/components/ui/template-badge-textarea";
import {
  getAllDaprActivities,
  getDaprActivity,
  type DaprActivity,
  type DaprActivityConfigField,
} from "@/lib/dapr-activity-registry";

type ActivityConfigProps = {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled?: boolean;
};

function renderActivityField(
  field: DaprActivityConfigField,
  config: Record<string, unknown>,
  onUpdateConfig: (key: string, value: string) => void,
  disabled?: boolean
) {
  const value = (config[field.key] as string) || field.defaultValue || "";

  switch (field.type) {
    case "template-input":
      return (
        <div className="space-y-2" key={field.key}>
          <Label className="ml-1" htmlFor={field.key}>
            {field.label}
          </Label>
          <TemplateBadgeInput
            disabled={disabled}
            id={field.key}
            onChange={(val) => onUpdateConfig(field.key, val)}
            placeholder={field.placeholder}
            value={value}
          />
        </div>
      );
    case "template-textarea":
      return (
        <div className="space-y-2" key={field.key}>
          <Label className="ml-1" htmlFor={field.key}>
            {field.label}
          </Label>
          <TemplateBadgeTextarea
            disabled={disabled}
            id={field.key}
            onChange={(val) => onUpdateConfig(field.key, val)}
            placeholder={field.placeholder}
            rows={field.rows || 4}
            value={value}
          />
        </div>
      );
    case "number":
      return (
        <div className="space-y-2" key={field.key}>
          <Label className="ml-1" htmlFor={field.key}>
            {field.label}
          </Label>
          <Input
            disabled={disabled}
            id={field.key}
            min={field.min}
            onChange={(e) => onUpdateConfig(field.key, e.target.value)}
            placeholder={field.placeholder}
            type="number"
            value={value}
          />
        </div>
      );
    case "select":
      return (
        <div className="space-y-2" key={field.key}>
          <Label className="ml-1" htmlFor={field.key}>
            {field.label}
          </Label>
          <Select
            disabled={disabled}
            onValueChange={(val) => onUpdateConfig(field.key, val)}
            value={value || undefined}
          >
            <SelectTrigger className="w-full" id={field.key}>
              <SelectValue placeholder={field.placeholder} />
            </SelectTrigger>
            <SelectContent>
              {field.options?.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    default:
      return (
        <div className="space-y-2" key={field.key}>
          <Label className="ml-1" htmlFor={field.key}>
            {field.label}
          </Label>
          <Input
            disabled={disabled}
            id={field.key}
            onChange={(e) => onUpdateConfig(field.key, e.target.value)}
            placeholder={field.placeholder}
            value={value}
          />
        </div>
      );
  }
}

export function ActivityConfig({
  config,
  onUpdateConfig,
  disabled,
}: ActivityConfigProps) {
  const activities = useMemo(() => getAllDaprActivities(), []);
  const selectedActivityName = (config.activityName as string) || "";
  const selectedActivity = useMemo(
    () => getDaprActivity(selectedActivityName),
    [selectedActivityName]
  );

  // Group activities by category
  const activitiesByCategory = useMemo(() => {
    const grouped: Record<string, DaprActivity[]> = {};
    for (const activity of activities) {
      if (!grouped[activity.category]) {
        grouped[activity.category] = [];
      }
      grouped[activity.category].push(activity);
    }
    return grouped;
  }, [activities]);

  const handleActivityChange = (activityName: string) => {
    onUpdateConfig("activityName", activityName);
    // Clear activity-specific fields when switching
    const newActivity = getDaprActivity(activityName);
    if (newActivity) {
      // Optionally set default values
      for (const field of newActivity.inputFields) {
        if (field.defaultValue && !config[field.key]) {
          onUpdateConfig(field.key, field.defaultValue);
        }
      }
    }
  };

  return (
    <>
      {/* Activity Selector */}
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="activityName">
          Activity
        </Label>
        <Select
          disabled={disabled}
          onValueChange={handleActivityChange}
          value={selectedActivityName || undefined}
        >
          <SelectTrigger className="w-full" id="activityName">
            <SelectValue placeholder="Select activity" />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(activitiesByCategory).map(
              ([category, categoryActivities]) => (
                <div key={category}>
                  <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wider">
                    {category}
                  </div>
                  {categoryActivities.map((activity) => (
                    <SelectItem key={activity.name} value={activity.name}>
                      {activity.label}
                    </SelectItem>
                  ))}
                </div>
              )
            )}
          </SelectContent>
        </Select>
        {selectedActivity && (
          <p className="text-muted-foreground text-xs">
            {selectedActivity.description}
          </p>
        )}
      </div>

      {/* Dynamic Input Fields */}
      {selectedActivity &&
        selectedActivity.inputFields.map((field) =>
          renderActivityField(field, config, onUpdateConfig, disabled)
        )}

      {/* Timeout Override */}
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="timeout">
          Timeout (seconds)
        </Label>
        <Input
          disabled={disabled}
          id="timeout"
          min={1}
          onChange={(e) => onUpdateConfig("timeout", e.target.value)}
          placeholder={
            selectedActivity
              ? `Default: ${selectedActivity.timeout || 30}`
              : "30"
          }
          type="number"
          value={(config.timeout as string) || ""}
        />
        <p className="text-muted-foreground text-xs">
          Override the default activity timeout
        </p>
      </div>
    </>
  );
}
