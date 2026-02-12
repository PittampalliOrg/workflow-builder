import type React from "react";

/**
 * Shared Action/Integration Types
 *
 * These types are used by the Workflow Builder UI and the ActivePieces adapter.
 * They intentionally do not depend on the legacy `plugins/*` registry.
 */

/** Integration type identifier string (e.g., "google-sheets", "slack") */
export type IntegrationType = string;

/**
 * Select Option
 * Used for select/dropdown fields
 */
export type SelectOption = {
	value: string;
	label: string;
};

/**
 * Base Action Config Field
 * Declarative definition of a config field for an action
 */
export type ActionConfigFieldBase = {
	// Unique key for this field in the config object
	key: string;

	// Human-readable label
	label: string;

	// Field type
	type:
		| "template-input" // TemplateBadgeInput - supports {{variable}}
		| "template-textarea" // TemplateBadgeTextarea - supports {{variable}}
		| "text" // Regular text input
		| "number" // Number input
		| "select" // Dropdown select
		| "model-selector" // Vercel AI Elements ModelSelector (specialized dropdown UX)
		| "dynamic-select" // Async dropdown loaded from external API
		| "dynamic-multi-select" // Async multi-select dropdown
		| "schema-builder"; // Schema builder for structured output

	// Placeholder text
	placeholder?: string;

	// Default value
	defaultValue?: string;

	// Example value for AI prompt generation
	example?: string;

	// For select fields: list of options
	options?: SelectOption[];

	// Number of rows (for textarea)
	rows?: number;

	// Min value (for number fields)
	min?: number;

	// Whether this field is required (defaults to false)
	required?: boolean;

	// Conditional rendering: only show if another field has a specific value
	showWhen?: {
		field: string;
		equals: string;
	};

	// For dynamic-select / dynamic-multi-select: async options metadata
	dynamicOptions?: {
		provider?: "pieces" | "planner";
		pieceName: string;
		actionName: string;
		propName: string;
		refreshers: string[]; // other prop keys that trigger re-fetch
	};
};

/**
 * Config Field Group
 * Groups related fields together in a collapsible section
 */
export type ActionConfigFieldGroup = {
	// Human-readable label for the group
	label: string;

	// Field type (always "group" for groups)
	type: "group";

	// Nested fields within this group
	fields: ActionConfigFieldBase[];

	// Whether the group is expanded by default (defaults to false)
	defaultExpanded?: boolean;
};

/**
 * Action Config Field
 * Can be either a regular field or a group of fields
 */
export type ActionConfigField = ActionConfigFieldBase | ActionConfigFieldGroup;

/**
 * Output Field Definition
 * Describes an output field available for template autocomplete
 */
export type OutputField = {
	field: string;
	description: string;
};

/**
 * Result Component Props
 * Props passed to custom result components
 */
export type ResultComponentProps = {
	output: unknown;
	input?: unknown;
};

/**
 * Output Display Config
 * Specifies how to render step output in the workflow runs panel
 */
export type OutputDisplayConfig =
	| {
			type: "image" | "video" | "url";
			field: string;
	  }
	| {
			type: "component";
			component: React.ComponentType<ResultComponentProps>;
	  };

/**
 * Action Definition
 * (UI-facing metadata; runtime execution is handled by function-router → fn-activepieces)
 */
export type ActionDefinition = {
	/** Full action ID: `{integration}/{slug}` e.g. `google-sheets/insert_row` */
	id: string;
	integration: IntegrationType;
	slug: string;
	label: string;
	description: string;
	/** Category label used for grouping in UI (typically the piece display name) */
	category: string;
	configFields: ActionConfigField[];
	outputFields?: OutputField[];
	outputConfig?: OutputDisplayConfig;
};

/**
 * Integration Definition
 * (ActivePieces piece mapped into a UI-friendly integration model)
 */
export type IntegrationDefinition = {
	type: IntegrationType;
	label: string;
	pieceName: string;
	logoUrl: string;
	actions: Omit<ActionDefinition, "id" | "integration">[];
};
