"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type TimerConfigProps = {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled?: boolean;
};

export function TimerConfig({
  config,
  onUpdateConfig,
  disabled,
}: TimerConfigProps) {
  const unit = (config.durationUnit as string) || "seconds";
  const duration = (config.duration as string) || "";

  // Calculate display value and unit label
  const getUnitLabel = () => {
    switch (unit) {
      case "minutes":
        return "minutes";
      case "hours":
        return "hours";
      case "days":
        return "days";
      default:
        return "seconds";
    }
  };

  return (
    <>
      {/* Duration */}
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="duration">
          Duration
        </Label>
        <div className="flex gap-2">
          <Input
            className="flex-1"
            disabled={disabled}
            id="duration"
            min={1}
            onChange={(e) => onUpdateConfig("duration", e.target.value)}
            placeholder="30"
            type="number"
            value={duration}
          />
          <Select
            disabled={disabled}
            onValueChange={(value) => onUpdateConfig("durationUnit", value)}
            value={unit}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="seconds">Seconds</SelectItem>
              <SelectItem value="minutes">Minutes</SelectItem>
              <SelectItem value="hours">Hours</SelectItem>
              <SelectItem value="days">Days</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="text-muted-foreground text-xs">
          The workflow will pause for {duration || "the specified"}{" "}
          {getUnitLabel()} before continuing. Uses{" "}
          <code className="rounded bg-muted px-1">ctx.create_timer()</code> in
          Dapr.
        </p>
      </div>

      {/* Timer Description */}
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="timerDescription">
          Description
        </Label>
        <Input
          disabled={disabled}
          id="timerDescription"
          onChange={(e) => onUpdateConfig("timerDescription", e.target.value)}
          placeholder="e.g., Wait before retry, Cooldown period"
          value={(config.timerDescription as string) || ""}
        />
        <p className="text-muted-foreground text-xs">
          Optional description for this timer step
        </p>
      </div>
    </>
  );
}
