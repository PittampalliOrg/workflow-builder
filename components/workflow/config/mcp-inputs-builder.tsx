"use client";

import { Plus, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type McpInputProperty = {
  id?: string;
  name: string;
  type: "TEXT" | "NUMBER" | "BOOLEAN" | "DATE" | "ARRAY" | "OBJECT";
  required: boolean;
  description?: string;
};

type Props = {
  value: McpInputProperty[];
  onChange: (next: McpInputProperty[]) => void;
  disabled?: boolean;
};

export function McpInputsBuilder({ value, onChange, disabled }: Props) {
  const add = () => {
    onChange([
      ...value,
      { id: nanoid(), name: "", type: "TEXT", required: true, description: "" },
    ]);
  };

  const update = (idx: number, patch: Partial<McpInputProperty>) => {
    const next = [...value];
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  };

  const remove = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-3">
      {value.map((prop, idx) => {
        const key = prop.id || `${idx}`;
        return (
          <div className="space-y-2 rounded-md border p-3" key={key}>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-2">
                <Label className="ml-1" htmlFor={`mcp-name-${idx}`}>
                  Name
                </Label>
                <Input
                  disabled={disabled}
                  id={`mcp-name-${idx}`}
                  onChange={(e) => update(idx, { name: e.target.value })}
                  placeholder="parameterName"
                  value={prop.name}
                />
              </div>

              <div className="flex-1 space-y-2">
                <Label className="ml-1" htmlFor={`mcp-type-${idx}`}>
                  Type
                </Label>
                <Select
                  disabled={disabled}
                  onValueChange={(v) =>
                    update(idx, { type: v as McpInputProperty["type"] })
                  }
                  value={prop.type}
                >
                  <SelectTrigger className="w-full" id={`mcp-type-${idx}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TEXT">Text</SelectItem>
                    <SelectItem value="NUMBER">Number</SelectItem>
                    <SelectItem value="BOOLEAN">Boolean</SelectItem>
                    <SelectItem value="DATE">Date</SelectItem>
                    <SelectItem value="ARRAY">Array</SelectItem>
                    <SelectItem value="OBJECT">Object</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-2 pb-1">
                <Checkbox
                  checked={prop.required}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    update(idx, { required: Boolean(checked) })
                  }
                />
                <span className="text-muted-foreground text-sm">Required</span>
              </div>

              <Button
                disabled={disabled}
                onClick={() => remove(idx)}
                size="icon"
                type="button"
                variant="ghost"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>

            <div className="space-y-2">
              <Label className="ml-1" htmlFor={`mcp-desc-${idx}`}>
                Description (optional)
              </Label>
              <Input
                disabled={disabled}
                id={`mcp-desc-${idx}`}
                onChange={(e) => update(idx, { description: e.target.value })}
                placeholder="Describe this parameter"
                value={prop.description || ""}
              />
            </div>
          </div>
        );
      })}

      <Button
        className="w-full"
        disabled={disabled}
        onClick={add}
        type="button"
        variant="outline"
      >
        <Plus className="size-4" />
        Add Parameter
      </Button>
    </div>
  );
}
