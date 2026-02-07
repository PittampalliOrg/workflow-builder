"use client";

import {
  AlertTriangle,
  Check,
  ChevronsUpDown,
  RefreshCcw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ActionConfigFieldBase } from "@/plugins/registry";
import { cn } from "@/lib/utils";

interface DropdownOption {
  label: string;
  value: unknown;
}

interface DropdownState {
  options: DropdownOption[];
  disabled?: boolean;
  placeholder?: string;
}

interface DynamicSelectFieldProps {
  field: ActionConfigFieldBase;
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  config: Record<string, unknown>;
  multiSelect?: boolean;
}

function getExternalIdFromAuth(auth: unknown): string | undefined {
  if (typeof auth !== "string") return undefined;
  const match = auth.match(/\{\{connections\['([^']+)'\]\}\}/);
  return match?.[1];
}

/**
 * DynamicSelectField — AP-style searchable dropdown with async options.
 *
 * Modeled after Activepieces' SearchableSelect + DynamicDropdownPieceProperty:
 *  - Popover + Command (cmdk) for keyboard-navigable search
 *  - Refresh button to re-fetch options
 *  - Deselect (X) button to clear selection
 *  - Cached first dropdown state so selected label survives search miss
 *  - Refresher watching: re-fetches when dependency prop values change
 *  - Error fallback: text input with warning icon
 */
export function DynamicSelectField({
  field,
  value,
  onChange,
  disabled,
  config,
  multiSelect = false,
}: DynamicSelectFieldProps) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<DropdownOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [dropdownDisabled, setDropdownDisabled] = useState(false);
  const [dropdownPlaceholder, setDropdownPlaceholder] = useState<
    string | undefined
  >();
  const fetchIdRef = useRef(0);
  const isFirstRender = useRef(true);
  const previousRefresherValues = useRef<string | undefined>(undefined);
  const cachedOptions = useRef<DropdownOption[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const dynamicOpts = field.dynamicOptions;
  const connectionExternalId = getExternalIdFromAuth(config.auth);

  // Build refresher dependency string for change detection
  const refresherValues = useMemo(() => {
    if (!dynamicOpts?.refreshers?.length) return "";
    return dynamicOpts.refreshers
      .map((r) => String(config[r] ?? ""))
      .join("|");
  }, [dynamicOpts?.refreshers, config]);

  const refresh = useCallback(async () => {
    if (!dynamicOpts) return;

    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const input: Record<string, unknown> = {};
      if (dynamicOpts.refreshers) {
        for (const key of dynamicOpts.refreshers) {
          if (config[key] !== undefined) {
            input[key] = config[key];
          }
        }
      }

      const res = await fetch("/api/pieces/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pieceName: dynamicOpts.pieceName,
          actionName: dynamicOpts.actionName,
          propertyName: dynamicOpts.propName,
          connectionExternalId,
          input,
        }),
      });

      if (fetchId !== fetchIdRef.current) return;

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(
          (errData as { error?: string }).error || `HTTP ${res.status}`
        );
      }

      const data = (await res.json()) as DropdownState;
      const opts = data.options || [];

      // Cache the first successful result (like AP does)
      if (cachedOptions.current.length === 0 && opts.length > 0) {
        cachedOptions.current = opts;
      }

      setOptions(opts);
      setDropdownDisabled(data.disabled ?? false);
      setDropdownPlaceholder(data.placeholder);
    } catch (err) {
      if (fetchId !== fetchIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load options");
      setOptions([]);
    } finally {
      if (fetchId === fetchIdRef.current) {
        setLoading(false);
      }
    }
  }, [dynamicOpts, connectionExternalId, config, refresherValues]);

  // Fetch on mount and when refresher values change
  useEffect(() => {
    // Clear selection when refresher values change (not on first render)
    if (
      !isFirstRender.current &&
      previousRefresherValues.current !== refresherValues
    ) {
      onChange(multiSelect ? "[]" : "");
    }

    previousRefresherValues.current = refresherValues;
    isFirstRender.current = false;
    refresh();
  }, [refresherValues]); // eslint-disable-line react-hooks/exhaustive-deps

  // Client-side filter
  const filteredOptions = useMemo(() => {
    if (!searchTerm) return options;
    const lower = searchTerm.toLowerCase();
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(lower) ||
        String(opt.value).toLowerCase().includes(lower)
    );
  }, [options, searchTerm]);

  // Resolve selected option label (check both current + cached)
  const selectedOption = useMemo(() => {
    if (!value || (multiSelect && value === "[]")) return undefined;

    if (multiSelect) {
      try {
        const values = JSON.parse(value) as unknown[];
        if (values.length === 0) return undefined;
        const allOpts = [...cachedOptions.current, ...options];
        const labels = values.map((v) => {
          const opt = allOpts.find((o) => String(o.value) === String(v));
          return opt?.label || String(v);
        });
        return { label: labels.join(", "), value };
      } catch {
        return undefined;
      }
    }

    const allOpts = [...cachedOptions.current, ...options];
    return allOpts.find((o) => String(o.value) === value);
  }, [value, options, multiSelect]);

  const isItemSelected = (optionValue: unknown): boolean => {
    if (multiSelect) {
      try {
        const current = value ? (JSON.parse(value) as unknown[]) : [];
        return current.some((v) => String(v) === String(optionValue));
      } catch {
        return false;
      }
    }
    return String(optionValue) === value;
  };

  const handleSelect = (idx: string) => {
    const optionIndex = parseInt(idx);
    if (isNaN(optionIndex) || optionIndex < 0) return;

    const option = options[optionIndex];
    if (!option) return;

    if (multiSelect) {
      try {
        const current = value ? (JSON.parse(value) as unknown[]) : [];
        const strVal = String(option.value);
        const existingIdx = current.findIndex((v) => String(v) === strVal);
        const next =
          existingIdx >= 0
            ? current.filter((_, i) => i !== existingIdx)
            : [...current, option.value];
        onChange(JSON.stringify(next));
      } catch {
        onChange(JSON.stringify([option.value]));
      }
    } else {
      onChange(String(option.value));
      setOpen(false);
    }
    setSearchTerm("");
  };

  const handleDeselect = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onChange(multiSelect ? "[]" : "");
  };

  const handleRefresh = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    refresh();
  };

  const isDisabled = disabled || dropdownDisabled;

  // Error state: fall back to text input with warning
  if (error && options.length === 0 && cachedOptions.current.length === 0) {
    return (
      <div className="flex items-center gap-2">
        <Input
          className="flex-1"
          disabled={disabled}
          id={field.key}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder || `Enter ${field.label}`}
          value={value}
        />
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertTriangle className="size-4 shrink-0 text-amber-500" />
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-60 text-xs">
                Could not load options: {error}. You can type a value manually.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  }

  const placeholder =
    dropdownPlaceholder || field.placeholder || "Select an option";

  return (
    <Popover
      modal
      onOpenChange={(isOpen) => {
        if (!isOpen && searchTerm) {
          setSearchTerm("");
        }
        setOpen(isOpen);
      }}
      open={open}
    >
      <PopoverTrigger
        asChild
        className={cn({ "cursor-not-allowed opacity-80": isDisabled })}
        onClick={(e) => {
          if (isDisabled) {
            e.preventDefault();
          }
          e.stopPropagation();
        }}
      >
        <div className="relative">
          <Button
            ref={triggerRef}
            aria-expanded={open}
            className="w-full justify-between font-normal"
            disabled={isDisabled}
            onClick={(e) => {
              setOpen(!open);
              e.preventDefault();
            }}
            role="combobox"
            variant="outline"
          >
            <span className="flex w-full truncate select-none">
              {loading && !selectedOption ? (
                <span className="text-muted-foreground">Loading...</span>
              ) : selectedOption ? (
                selectedOption.label
              ) : (
                <span className="text-muted-foreground">{placeholder}</span>
              )}
            </span>
            <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
          </Button>
          {/* Utility buttons (refresh + deselect) — shown on right side */}
          <div className="absolute right-10 top-2 z-50 flex items-center gap-1">
            {selectedOption && !isDisabled && !loading && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      className="size-6 shrink-0 opacity-50"
                      onClick={handleDeselect}
                      size="icon"
                      variant="ghost"
                    >
                      <X className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Unset</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {!loading && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      className="size-6 shrink-0 opacity-50"
                      onClick={handleRefresh}
                      size="icon"
                      variant="ghost"
                    >
                      <RefreshCcw className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Refresh</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
      </PopoverTrigger>
      <PopoverContent
        className="w-full min-w-full p-0"
        style={{
          maxWidth: triggerRef.current
            ? `${triggerRef.current.clientWidth}px`
            : undefined,
          minWidth: triggerRef.current
            ? `${triggerRef.current.clientWidth}px`
            : undefined,
        }}
      >
        <Command className="w-full" shouldFilter={false}>
          <CommandInput
            onValueChange={(val) => setSearchTerm(val)}
            placeholder={placeholder}
            value={searchTerm}
          />
          {filteredOptions.length === 0 && !loading && (
            <CommandEmpty>No results found.</CommandEmpty>
          )}
          <CommandGroup>
            <CommandList>
              {!loading &&
                filteredOptions.map((option, idx) => {
                  // Find the original index in options array
                  const originalIndex = options.indexOf(option);
                  return (
                    <CommandItem
                      className="flex items-center justify-between gap-2"
                      key={originalIndex}
                      onSelect={(currentValue) => {
                        handleSelect(currentValue);
                        if (!multiSelect) setOpen(false);
                      }}
                      value={String(originalIndex)}
                    >
                      <span className="truncate">{option.label}</span>
                      <Check
                        className={cn("size-4 shrink-0", {
                          hidden: !isItemSelected(option.value),
                        })}
                      />
                    </CommandItem>
                  );
                })}
              {loading && (
                <CommandItem disabled>Loading...</CommandItem>
              )}
            </CommandList>
          </CommandGroup>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
