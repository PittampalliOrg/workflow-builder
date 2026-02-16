"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { HelpCircle, Plus, Settings } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AddConnectionOverlay } from "@/components/overlays/add-connection-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import { IntegrationSelector } from "@/components/ui/integration-selector";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	connectionsAtom,
	connectionsVersionAtom,
} from "@/lib/connections-store";
import type { IntegrationType } from "@/lib/actions/types";
import {
	getRequiredConnectionForAction,
	requiresConnectionForIntegration,
} from "@/lib/actions/connection-utils";
import { usePiecesCatalog } from "@/lib/actions/pieces-store";
import type { ApIntegration } from "@/lib/activepieces/action-adapter";
import { ActionConfigRenderer } from "./action-config-renderer";
import { SchemaBuilder, type SchemaField } from "./schema-builder";

type ActionConfigProps = {
	config: Record<string, unknown>;
	onUpdateConfig: (key: string, value: string) => void;
	disabled: boolean;
	isOwner?: boolean;
};

// Database Query fields component
function DatabaseQueryFields({
	config,
	onUpdateConfig,
	disabled,
}: {
	config: Record<string, unknown>;
	onUpdateConfig: (key: string, value: string) => void;
	disabled: boolean;
}) {
	return (
		<>
			<div className="space-y-2">
				<Label htmlFor="dbQuery">SQL Query</Label>
				<div className="overflow-hidden rounded-md border">
					<CodeEditor
						defaultLanguage="sql"
						height="150px"
						onChange={(value) => onUpdateConfig("dbQuery", value || "")}
						options={{
							minimap: { enabled: false },
							lineNumbers: "on",
							scrollBeyondLastLine: false,
							fontSize: 12,
							readOnly: disabled,
							wordWrap: "off",
						}}
						value={(config?.dbQuery as string) || ""}
					/>
				</div>
				<p className="text-muted-foreground text-xs">
					The DATABASE_URL from your project integrations will be used to
					execute this query.
				</p>
			</div>
			<div className="space-y-2">
				<Label>Schema (Optional)</Label>
				<SchemaBuilder
					disabled={disabled}
					onChange={(schema) =>
						onUpdateConfig("dbSchema", JSON.stringify(schema))
					}
					schema={
						config?.dbSchema
							? (JSON.parse(config.dbSchema as string) as SchemaField[])
							: []
					}
				/>
			</div>
		</>
	);
}

// HTTP Request fields component
function HttpRequestFields({
	config,
	onUpdateConfig,
	disabled,
}: {
	config: Record<string, unknown>;
	onUpdateConfig: (key: string, value: string) => void;
	disabled: boolean;
}) {
	return (
		<>
			<div className="space-y-2">
				<Label htmlFor="httpMethod">HTTP Method</Label>
				<Select
					disabled={disabled}
					onValueChange={(value) => onUpdateConfig("httpMethod", value)}
					value={(config?.httpMethod as string) || "POST"}
				>
					<SelectTrigger className="w-full" id="httpMethod">
						<SelectValue placeholder="Select method" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="GET">GET</SelectItem>
						<SelectItem value="POST">POST</SelectItem>
						<SelectItem value="PUT">PUT</SelectItem>
						<SelectItem value="PATCH">PATCH</SelectItem>
						<SelectItem value="DELETE">DELETE</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<div className="space-y-2">
				<Label htmlFor="endpoint">URL</Label>
				<TemplateBadgeInput
					disabled={disabled}
					id="endpoint"
					onChange={(value) => onUpdateConfig("endpoint", value)}
					placeholder="https://api.example.com/endpoint or {{NodeName.url}}"
					value={(config?.endpoint as string) || ""}
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="httpHeaders">Headers (JSON)</Label>
				<div className="overflow-hidden rounded-md border">
					<CodeEditor
						defaultLanguage="json"
						height="100px"
						onChange={(value) => onUpdateConfig("httpHeaders", value || "{}")}
						options={{
							minimap: { enabled: false },
							lineNumbers: "off",
							scrollBeyondLastLine: false,
							fontSize: 12,
							readOnly: disabled,
							wordWrap: "off",
						}}
						value={(config?.httpHeaders as string) || "{}"}
					/>
				</div>
			</div>
			<div className="space-y-2">
				<Label htmlFor="httpBody">Body (JSON)</Label>
				<div
					className={`overflow-hidden rounded-md border ${config?.httpMethod === "GET" ? "opacity-50" : ""}`}
				>
					<CodeEditor
						defaultLanguage="json"
						height="120px"
						onChange={(value) => onUpdateConfig("httpBody", value || "{}")}
						options={{
							minimap: { enabled: false },
							lineNumbers: "off",
							scrollBeyondLastLine: false,
							fontSize: 12,
							readOnly: config?.httpMethod === "GET" || disabled,
							domReadOnly: config?.httpMethod === "GET" || disabled,
							wordWrap: "off",
						}}
						value={(config?.httpBody as string) || "{}"}
					/>
				</div>
				{config?.httpMethod === "GET" && (
					<p className="text-muted-foreground text-xs">
						Body is disabled for GET requests
					</p>
				)}
			</div>
		</>
	);
}

// Condition fields component
function ConditionFields({
	config,
	onUpdateConfig,
	disabled,
}: {
	config: Record<string, unknown>;
	onUpdateConfig: (key: string, value: string) => void;
	disabled: boolean;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor="condition">Condition Expression</Label>
			<TemplateBadgeInput
				disabled={disabled}
				id="condition"
				onChange={(value) => onUpdateConfig("condition", value)}
				placeholder="e.g., 5 > 3, status === 200, {{PreviousNode.value}} > 100"
				value={(config?.condition as string) || ""}
			/>
			<p className="text-muted-foreground text-xs">
				Enter a JavaScript expression that evaluates to true or false. You can
				use @ to reference previous node outputs.
			</p>
		</div>
	);
}

// System action fields wrapper - extracts conditional rendering to reduce complexity
function SystemActionFields({
	actionType,
	config,
	onUpdateConfig,
	disabled,
}: {
	actionType: string;
	config: Record<string, unknown>;
	onUpdateConfig: (key: string, value: string) => void;
	disabled: boolean;
}) {
	switch (actionType) {
		case "system/http-request":
			return (
				<HttpRequestFields
					config={config}
					disabled={disabled}
					onUpdateConfig={onUpdateConfig}
				/>
			);
		case "system/database-query":
			return (
				<DatabaseQueryFields
					config={config}
					disabled={disabled}
					onUpdateConfig={onUpdateConfig}
				/>
			);
		case "system/condition":
			return (
				<ConditionFields
					config={config}
					disabled={disabled}
					onUpdateConfig={onUpdateConfig}
				/>
			);
		default:
			return null;
	}
}

// System actions that don't have plugins
// id is the canonical function slug used by the orchestrator/function-router
const SYSTEM_ACTIONS: Array<{ id: string; label: string }> = [
	{ id: "system/http-request", label: "HTTP Request" },
	{
		id: "system/database-query",
		label: "Database Query",
	},
	{ id: "system/condition", label: "Condition" },
];

const SYSTEM_ACTION_IDS = SYSTEM_ACTIONS.map((a) => a.id);

// System actions that need integrations (not in plugin registry)
const SYSTEM_ACTION_INTEGRATIONS: Record<string, IntegrationType> = {
	"system/database-query": "database",
};

// Build category mapping from System + ActivePieces pieces
function useCategoryData(apPieces: ApIntegration[]) {
	return useMemo(() => {
		const allCategories: Record<
			string,
			Array<{ id: string; label: string }>
		> = {
			System: SYSTEM_ACTIONS,
		};

		// Each piece displayName is a category; each action is an item.
		for (const piece of apPieces) {
			allCategories[piece.label] = piece.actions.map((action) => ({
				id: `${piece.type}/${action.slug}`,
				label: action.label,
			}));
		}

		return allCategories;
	}, [apPieces]);
}

// Get category for an action type (supports both new IDs, labels, and legacy labels)
function getCategoryForAction(
	actionType: string,
	apPieces?: ApIntegration[],
): string | null {
	const normalizedActionType = normalizeActionType(actionType);

	// Check system actions first
	if (SYSTEM_ACTION_IDS.includes(normalizedActionType)) {
		return "System";
	}

	// Check AP pieces directly
	if (apPieces) {
		const [pieceName] = normalizedActionType.split("/");
		const piece = apPieces.find((p) => p.type === pieceName);
		if (piece) return piece.label;
	}

	return null;
}

// Normalize action type to new ID format (handles legacy labels via findActionById)
function normalizeActionType(actionType: string): string {
	const normalizedActionType = actionType;

	// Check system actions first - they use their label as ID
	if (SYSTEM_ACTION_IDS.includes(normalizedActionType)) {
		return normalizedActionType;
	}

	return normalizedActionType;
}

// Get the canonical function slug for an action
// This is the identifier used by the orchestrator and function-runner
function getSlugForAction(actionType: string): string | null {
	const normalizedActionType = normalizeActionType(actionType);

	// Check system actions first
	const systemAction = SYSTEM_ACTIONS.find(
		(a) => a.id === normalizedActionType,
	);
	if (systemAction) {
		return systemAction.id;
	}

	// For piece actions, the action type is already the canonical slug
	return normalizedActionType;
}

function buildConnectionAuthTemplate(externalId: string): string {
	return `{{connections['${externalId}']}}`;
}

function getExternalIdFromAuthTemplate(
	auth: string | undefined,
): string | undefined {
	if (!auth) return undefined;
	const match = auth.match(/\{\{connections\['([^']+)'\]\}\}/);
	return match?.[1];
}

export function ActionConfig({
	config,
	onUpdateConfig,
	disabled,
	isOwner = true,
}: ActionConfigProps) {
	const actionType = (config?.actionType as string) || "";
	const normalizedActionType = normalizeActionType(actionType);
	const {
		pieces: apPieces,
		findActionById,
		getIntegration,
	} = usePiecesCatalog();

	const categories = useCategoryData(apPieces);

	const selectedCategory = normalizedActionType
		? getCategoryForAction(normalizedActionType, apPieces)
		: null;
	const [category, setCategory] = useState<string>(selectedCategory || "");
	const setIntegrationsVersion = useSetAtom(connectionsVersionAtom);
	const globalIntegrations = useAtomValue(connectionsAtom);
	const { push } = useOverlay();

	// Sync category state when actionType changes (e.g., when switching nodes)
	useEffect(() => {
		const newCategory = normalizedActionType
			? getCategoryForAction(normalizedActionType, apPieces)
			: null;
		setCategory(newCategory || "");
	}, [normalizedActionType, apPieces]);

	const handleCategoryChange = (newCategory: string) => {
		setCategory(newCategory);
		// Auto-select the first action in the new category
		const firstAction = categories[newCategory]?.[0];
		if (firstAction) {
			// Set actionType to the canonical slug (used by orchestrator/function-runner)
			const actionType = getSlugForAction(firstAction.id);
			if (actionType) {
				onUpdateConfig("actionType", actionType);
			}
		}
	};

	const handleActionTypeChange = (value: string) => {
		// Set actionType to the canonical slug (used by orchestrator/function-runner)
		const actionType = getSlugForAction(value);
		if (actionType) {
			onUpdateConfig("actionType", actionType);
		}
	};

	// Adapter for plugin config components that expect (key, value: unknown)
	const handlePluginUpdateConfig = (key: string, value: unknown) => {
		onUpdateConfig(key, String(value));
	};

	// Get dynamic config fields for plugin actions
	const pieceAction = actionType ? findActionById(normalizedActionType) : null;

	// Determine the integration type for the current action
	const integrationType: IntegrationType | undefined = useMemo(() => {
		if (!normalizedActionType) {
			return;
		}

		const actionRequiredIntegration =
			getRequiredConnectionForAction(normalizedActionType);
		if (actionRequiredIntegration) {
			return actionRequiredIntegration;
		}

		// Check system actions first
		if (SYSTEM_ACTION_INTEGRATIONS[normalizedActionType]) {
			return SYSTEM_ACTION_INTEGRATIONS[normalizedActionType];
		}

		// Piece actions
		const action = findActionById(normalizedActionType);
		if (action?.integration) {
			return requiresConnectionForIntegration(action.integration)
				? action.integration
				: undefined;
		}

		// Fallback: extract piece name from slug
		const slashIdx = normalizedActionType.indexOf("/");
		if (slashIdx > 0) {
			const pieceName = normalizedActionType.slice(0, slashIdx);
			if (
				getIntegration(pieceName) &&
				requiresConnectionForIntegration(pieceName)
			) {
				return pieceName;
			}
		}

		return undefined;
	}, [normalizedActionType, findActionById, getIntegration]);

	// Check if there are existing connections for this integration type
	const hasExistingConnections = useMemo(() => {
		if (!integrationType) return false;
		return globalIntegrations.some((i) => i.pieceName === integrationType);
	}, [integrationType, globalIntegrations]);

	// Derive the selected connection ID from the auth template
	const selectedConnectionId = useMemo(() => {
		const configuredIntegrationId = config?.integrationId as string | undefined;
		if (configuredIntegrationId) {
			return configuredIntegrationId;
		}

		const authTemplate = config?.auth as string | undefined;
		const externalId = getExternalIdFromAuthTemplate(authTemplate);
		if (!externalId) {
			return "";
		}

		const conn = globalIntegrations.find((i) => i.externalId === externalId);
		return conn?.id || "";
	}, [config?.integrationId, config?.auth, globalIntegrations]);

	const applySelectedConnection = (
		connectionId: string,
		externalId?: string,
	) => {
		// Always persist integrationId for UI validation and node warnings.
		// Runtime execution uses auth template -> externalId.
		onUpdateConfig("integrationId", connectionId || "");

		// If externalId is provided directly (e.g., from overlay creation),
		// use it immediately to avoid race condition with stale integrations list
		if (externalId) {
			onUpdateConfig("auth", buildConnectionAuthTemplate(externalId));
			return;
		}

		if (!connectionId) {
			onUpdateConfig("auth", "");
			return;
		}

		const selectedConnection = globalIntegrations.find(
			(i) => i.id === connectionId,
		);
		if (selectedConnection?.externalId) {
			onUpdateConfig(
				"auth",
				buildConnectionAuthTemplate(selectedConnection.externalId),
			);
			return;
		}

		// Defensive: if we can't resolve externalId, clear auth so execution doesn't
		// accidentally use a stale connection template.
		onUpdateConfig("auth", "");
	};

	const openConnectionOverlay = () => {
		if (integrationType) {
			push(AddConnectionOverlay, {
				preselectedPieceName: integrationType,
				onSuccess: (connectionId: string, externalId?: string) => {
					setIntegrationsVersion((v) => v + 1);
					applySelectedConnection(connectionId, externalId);
				},
			});
		}
	};

	const handleAddSecondaryConnection = () => {
		openConnectionOverlay();
	};

	return (
		<>
			<div className="grid grid-cols-2 gap-2">
				<div className="space-y-2">
					<Label className="ml-1" htmlFor="actionCategory">
						Service
					</Label>
					<Select
						disabled={disabled}
						onValueChange={handleCategoryChange}
						value={category || undefined}
					>
						<SelectTrigger className="w-full" id="actionCategory">
							<SelectValue placeholder="Select category" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="System">
								<div className="flex items-center gap-2">
									<Settings className="size-4" />
									<span>System</span>
								</div>
							</SelectItem>
							<SelectSeparator />
							{apPieces.length > 0 && (
								<>
									{apPieces.map((piece) => (
										<SelectItem key={piece.type} value={piece.label}>
											<div className="flex items-center gap-2">
												<IntegrationIcon
													className="size-4"
													integration={piece.type}
													logoUrl={piece.logoUrl}
												/>
												<span>{piece.label}</span>
											</div>
										</SelectItem>
									))}
								</>
							)}
						</SelectContent>
					</Select>
				</div>

				<div className="space-y-2">
					<Label className="ml-1" htmlFor="actionType">
						Action
					</Label>
					<Select
						disabled={disabled || !category}
						onValueChange={handleActionTypeChange}
						value={normalizeActionType(actionType) || undefined}
					>
						<SelectTrigger className="w-full" id="actionType">
							<SelectValue placeholder="Select action" />
						</SelectTrigger>
						<SelectContent>
							{category &&
								categories[category]?.map((action) => (
									<SelectItem key={action.id} value={action.id}>
										{action.label}
									</SelectItem>
								))}
						</SelectContent>
					</Select>
				</div>
			</div>

			{integrationType && isOwner && (
				<div className="space-y-2" id="connection" tabIndex={-1}>
					<div className="ml-1 flex items-center justify-between">
						<div className="flex items-center gap-1">
							<Label>Connection</Label>
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<HelpCircle className="size-3.5 text-muted-foreground" />
									</TooltipTrigger>
									<TooltipContent>
										<p>API key or OAuth credentials for this service</p>
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
						</div>
						{hasExistingConnections && (
							<Button
								className="size-6"
								disabled={disabled}
								onClick={handleAddSecondaryConnection}
								size="icon"
								variant="ghost"
							>
								<Plus className="size-4" />
							</Button>
						)}
					</div>
					<IntegrationSelector
						disabled={disabled}
						integrationType={integrationType}
						onChange={(id) => applySelectedConnection(id)}
						value={selectedConnectionId}
					/>
				</div>
			)}

			{/* System actions - hardcoded config fields */}
			<SystemActionFields
				actionType={normalizedActionType}
				config={config}
				disabled={disabled}
				onUpdateConfig={onUpdateConfig}
			/>

			{/* Plugin actions - declarative config fields */}
			{pieceAction && !SYSTEM_ACTION_IDS.includes(normalizedActionType) && (
				<ActionConfigRenderer
					config={config}
					disabled={disabled}
					fields={pieceAction.configFields}
					onUpdateConfig={handlePluginUpdateConfig}
				/>
			)}
		</>
	);
}
