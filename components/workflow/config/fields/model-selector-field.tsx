"use client";

import {
	ModelSelector,
	type ModelOption,
} from "@/components/ai-elements/model-selector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ActionConfigFieldBase } from "@/lib/actions/types";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type DropdownOption = {
	label: string;
	value: unknown;
};

type DropdownState = {
	options: DropdownOption[];
	disabled?: boolean;
	placeholder?: string;
};

type ModelSelectorFieldProps = {
	field: ActionConfigFieldBase;
	value: string;
	onChange: (value: unknown) => void;
	disabled?: boolean;
	config: Record<string, unknown>;
	className?: string;
};

function getExternalIdFromAuth(auth: unknown): string | undefined {
	if (typeof auth !== "string") {
		return;
	}
	const match = auth.match(/\{\{connections\['([^']+)'\]\}\}/);
	return match?.[1];
}

export function ModelSelectorField({
	field,
	value,
	onChange,
	disabled,
	config,
	className,
}: ModelSelectorFieldProps) {
	const [models, setModels] = useState<ModelOption[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dropdownDisabled, setDropdownDisabled] = useState(false);
	const [dropdownPlaceholder, setDropdownPlaceholder] = useState<
		string | undefined
	>(field.placeholder);

	const dynamicOpts = field.dynamicOptions;
	const connectionExternalId = getExternalIdFromAuth(config.auth);
	const configRef = useRef(config);
	const onChangeRef = useRef(onChange);
	const activeRequestRef = useRef<AbortController | null>(null);

	useEffect(() => {
		configRef.current = config;
	}, [config]);

	useEffect(() => {
		onChangeRef.current = onChange;
	}, [onChange]);

	useEffect(() => {
		return () => {
			activeRequestRef.current?.abort();
		};
	}, []);

	const refresh = useCallback(async () => {
		if (!dynamicOpts) {
			return;
		}

		activeRequestRef.current?.abort();
		const controller = new AbortController();
		activeRequestRef.current = controller;

		setLoading(true);
		setError(null);

		try {
			// Pass all configured values (except auth) for parity with AP-style resolvers.
			const input: Record<string, unknown> = {};
			for (const [key, configValue] of Object.entries(configRef.current)) {
				if (key === "auth") continue;
				if (configValue !== undefined) input[key] = configValue;
			}

			const optionsEndpoint =
				dynamicOpts.provider === "planner"
					? "/api/planner/options"
					: "/api/pieces/options";

			const requestBody: Record<string, unknown> = {
				actionName: dynamicOpts.actionName,
				propertyName: dynamicOpts.propName,
				connectionExternalId,
				input,
			};

			if (dynamicOpts.provider !== "planner") {
				requestBody.pieceName = dynamicOpts.pieceName;
			}

			const res = await fetch(optionsEndpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				signal: controller.signal,
				body: JSON.stringify(requestBody),
			});

			if (controller.signal.aborted) {
				return;
			}

			if (!res.ok) {
				const errData = (await res.json().catch(() => ({}))) as {
					error?: string;
					details?: string;
				};
				const baseMessage = errData.error || `HTTP ${res.status}`;
				const details = errData.details;
				throw new Error(details ? `${baseMessage}: ${details}` : baseMessage);
			}

			const data = (await res.json()) as DropdownState;
			const opts = data.options || [];

			setModels(
				opts
					.filter(
						(o): o is DropdownOption & { label: string; value: string } =>
							typeof o.label === "string" && typeof o.value === "string",
					)
					.map((o) => ({ id: o.value, name: o.label })),
			);
			setDropdownDisabled(data.disabled ?? false);
			setDropdownPlaceholder(data.placeholder ?? field.placeholder);
		} catch (err) {
			if (controller.signal.aborted) {
				return;
			}
			setError(err instanceof Error ? err.message : "Failed to load models");
			setModels([]);
		} finally {
			if (activeRequestRef.current === controller) {
				activeRequestRef.current = null;
			}
			setLoading(false);
		}
	}, [dynamicOpts, connectionExternalId, field.placeholder]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const selectedModel = useMemo<ModelOption | null>(() => {
		if (!value) {
			return null;
		}
		return models.find((m) => m.id === value) ?? { id: value, name: value };
	}, [models, value]);

	if (!dynamicOpts) {
		// Fallback: if the field wasn't configured correctly, at least allow typing.
		return (
			<Input
				className={className}
				disabled={disabled}
				id={field.key}
				onChange={(e) => onChange(e.target.value)}
				placeholder={field.placeholder}
				value={value}
			/>
		);
	}

	return (
		<div className={cn("space-y-2", className)}>
			<div className="flex items-center gap-2">
				<ModelSelector
					disabled={disabled || dropdownDisabled}
					models={models}
					onModelChange={(m) => onChangeRef.current(m.id)}
					placeholder={dropdownPlaceholder || "Select a model"}
					selectedModel={selectedModel}
				/>
				<Button
					aria-label="Refresh models"
					disabled={disabled || loading}
					onClick={() => void refresh()}
					size="icon"
					type="button"
					variant="outline"
				>
					<RefreshCcw className={cn("h-4 w-4", loading && "animate-spin")} />
				</Button>
			</div>
			{error ? (
				<div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-950 text-xs">
					<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
					<div className="min-w-0">
						<div className="font-medium">Failed to load models</div>
						<div className="break-words">{error}</div>
					</div>
				</div>
			) : null}
		</div>
	);
}
