/**
 * Activepieces Action Adapter
 *
 * Converts Activepieces piece action props (from piece_metadata.actions JSONB)
 * into Workflow Builder ActionConfigField[] format that the existing
 * ActionConfigRenderer can render.
 */

import type { PieceMetadataRecord } from "@/lib/db/piece-metadata";
import type {
  ActionConfigFieldBase,
  OutputField,
  PluginAction,
  SelectOption,
} from "@/plugins/registry";

/**
 * Activepieces prop types (from piece framework)
 */
type ApPropType =
  | "SHORT_TEXT"
  | "LONG_TEXT"
  | "NUMBER"
  | "CHECKBOX"
  | "STATIC_DROPDOWN"
  | "DROPDOWN"
  | "MULTI_SELECT_DROPDOWN"
  | "JSON"
  | "OBJECT"
  | "ARRAY"
  | "DATE_TIME"
  | "FILE"
  | "DYNAMIC"
  | "MARKDOWN"
  | "CUSTOM_AUTH"
  | "OAUTH2"
  | "SECRET_TEXT"
  | "BASIC_AUTH";

type ApProp = {
  type: ApPropType;
  displayName: string;
  description?: string;
  required?: boolean;
  defaultValue?: unknown;
  refreshers?: string[];
  options?: {
    options?: Array<{ label: string; value: string | number | boolean }>;
    disabled?: boolean;
    placeholder?: string;
  };
};

type ApAction = {
  name: string;
  displayName: string;
  description: string;
  props: Record<string, ApProp>;
  requireAuth?: boolean;
};

/**
 * AP piece as returned from piece_metadata with actions/triggers parsed
 */
export type ApIntegration = {
  type: string;
  label: string;
  pieceName: string;
  logoUrl: string;
  actions: PluginAction[];
};

/**
 * Convert a single AP prop to a WB config field.
 * Returns null for prop types that can't be rendered statically.
 */
function apPropToConfigField(
  key: string,
  prop: ApProp,
  pieceName: string,
  actionName: string
): ActionConfigFieldBase | null {
  const base = {
    key,
    label: prop.displayName || key,
    required: prop.required ?? false,
  };

  switch (prop.type) {
    case "SHORT_TEXT":
      return {
        ...base,
        type: "template-input" as const,
        placeholder: prop.description || "",
        defaultValue:
          prop.defaultValue != null ? String(prop.defaultValue) : undefined,
      };

    case "LONG_TEXT":
      return {
        ...base,
        type: "template-textarea" as const,
        placeholder: prop.description || "",
        rows: 4,
        defaultValue:
          prop.defaultValue != null ? String(prop.defaultValue) : undefined,
      };

    case "NUMBER":
      return {
        ...base,
        type: "number" as const,
        placeholder: prop.description || "",
        defaultValue:
          prop.defaultValue != null ? String(prop.defaultValue) : undefined,
      };

    case "CHECKBOX":
      return {
        ...base,
        type: "select" as const,
        options: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ] satisfies SelectOption[],
        defaultValue:
          prop.defaultValue != null ? String(prop.defaultValue) : "false",
      };

    case "STATIC_DROPDOWN": {
      const options: SelectOption[] = (prop.options?.options || []).map(
        (opt) => ({
          value: String(opt.value),
          label: opt.label,
        })
      );
      if (options.length === 0) {
        // No static options, fall back to text input
        return {
          ...base,
          type: "template-input" as const,
          placeholder: prop.description || "",
        };
      }
      return {
        ...base,
        type: "select" as const,
        options,
        defaultValue:
          prop.defaultValue != null ? String(prop.defaultValue) : undefined,
      };
    }

    case "DROPDOWN":
      return {
        ...base,
        type: "dynamic-select" as const,
        placeholder: prop.description || `Select ${prop.displayName}`,
        dynamicOptions: {
          pieceName,
          actionName,
          propName: key,
          refreshers: prop.refreshers || [],
        },
      };

    case "MULTI_SELECT_DROPDOWN":
      return {
        ...base,
        type: "dynamic-multi-select" as const,
        placeholder: prop.description || `Select ${prop.displayName}`,
        dynamicOptions: {
          pieceName,
          actionName,
          propName: key,
          refreshers: prop.refreshers || [],
        },
      };

    case "JSON":
    case "OBJECT":
    case "ARRAY":
      return {
        ...base,
        type: "template-textarea" as const,
        placeholder: prop.description || "JSON value",
        rows: 4,
        defaultValue:
          prop.defaultValue != null
            ? typeof prop.defaultValue === "string"
              ? prop.defaultValue
              : JSON.stringify(prop.defaultValue, null, 2)
            : undefined,
      };

    case "DATE_TIME":
      return {
        ...base,
        type: "template-input" as const,
        placeholder: prop.description || "ISO 8601 datetime",
      };

    case "FILE":
      return {
        ...base,
        type: "template-input" as const,
        placeholder: prop.description || "File URL or base64",
      };

    // Auth props, dynamic, markdown, custom — skip
    case "DYNAMIC":
    case "MARKDOWN":
    case "CUSTOM_AUTH":
    case "OAUTH2":
    case "SECRET_TEXT":
    case "BASIC_AUTH":
      return null;

    default:
      // Unknown prop type, render as text input
      return {
        ...base,
        type: "template-input" as const,
        placeholder: prop.description || "",
      };
  }
}

/**
 * Convert an AP action definition to a WB PluginAction.
 *
 * Slug convention: {pieceName}/{actionName}
 * e.g. "google-sheets/insert_row"
 */
function convertApActionToWbAction(
  pieceName: string,
  actionName: string,
  action: ApAction,
  displayName: string
): PluginAction {
  const configFields: ActionConfigFieldBase[] = [];

  if (action.props) {
    for (const [key, prop] of Object.entries(action.props)) {
      const field = apPropToConfigField(key, prop, pieceName, actionName);
      if (field) {
        configFields.push(field);
      }
    }
  }

  // AP actions return generic objects — provide a generic output field
  const outputFields: OutputField[] = [
    { field: "data", description: "Action result data" },
  ];

  return {
    slug: actionName,
    label: action.displayName || actionName,
    description: action.description || "",
    category: displayName, // Group by piece display name
    // These are stubs for AP actions — execution is handled by fn-activepieces
    stepFunction: "execute",
    stepImportPath: `@activepieces/piece-${pieceName}`,
    configFields,
    outputFields,
  };
}

/**
 * Convert a full AP piece_metadata record to a WB integration format.
 *
 * Normalizes piece names by stripping the @activepieces/piece- prefix.
 */
export function convertApPieceToIntegration(
  piece: PieceMetadataRecord
): ApIntegration | null {
  // Normalize piece name: strip @activepieces/piece- prefix
  let pieceName = piece.name;
  if (pieceName.startsWith("@activepieces/piece-")) {
    pieceName = pieceName.slice("@activepieces/piece-".length);
  }

  // Parse actions from JSONB
  const rawActions = piece.actions as Record<string, ApAction> | null;
  if (!rawActions || typeof rawActions !== "object") {
    return null;
  }

  const actions: PluginAction[] = [];

  for (const [actionName, action] of Object.entries(rawActions)) {
    if (!action || typeof action !== "object") {
      continue;
    }
    actions.push(
      convertApActionToWbAction(
        pieceName,
        actionName,
        action,
        piece.displayName
      )
    );
  }

  if (actions.length === 0) {
    return null;
  }

  return {
    type: pieceName,
    label: piece.displayName,
    pieceName,
    logoUrl: piece.logoUrl,
    actions,
  };
}

/**
 * Convert multiple piece_metadata records to WB integrations.
 * Filters out pieces with no convertible actions.
 */
export function convertApPiecesToIntegrations(
  pieces: PieceMetadataRecord[]
): ApIntegration[] {
  const integrations: ApIntegration[] = [];

  for (const piece of pieces) {
    const integration = convertApPieceToIntegration(piece);
    if (integration) {
      integrations.push(integration);
    }
  }

  return integrations;
}
