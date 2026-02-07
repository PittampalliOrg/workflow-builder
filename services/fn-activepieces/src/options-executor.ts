/**
 * Options Executor
 *
 * Loads an AP piece, finds a DROPDOWN prop, and calls its options() function
 * to return dynamic dropdown choices (e.g., list of Google Calendars).
 */
import { getPiece } from './piece-registry.js';

export interface OptionsRequest {
  pieceName: string;
  actionName: string;
  propertyName: string;
  auth: unknown;
  input: Record<string, unknown>;
  searchValue?: string;
}

export interface DropdownOption {
  label: string;
  value: unknown;
}

export interface DropdownState {
  options: DropdownOption[];
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Fetch dynamic dropdown options for a piece action property.
 */
export async function fetchOptions(
  request: OptionsRequest
): Promise<DropdownState> {
  const { pieceName, actionName, propertyName, auth, input, searchValue } =
    request;

  // Look up piece
  const piece = getPiece(pieceName);
  if (!piece) {
    throw new Error(
      `Piece "${pieceName}" is not installed in fn-activepieces.`
    );
  }

  // Look up action
  const action = piece.getAction(actionName);
  if (!action) {
    throw new Error(
      `Action "${actionName}" not found in piece "${pieceName}".`
    );
  }

  // Find the property
  const prop = (action.props as Record<string, unknown>)?.[propertyName] as
    | { options?: unknown }
    | undefined;
  if (!prop) {
    throw new Error(
      `Property "${propertyName}" not found in action "${actionName}" of piece "${pieceName}".`
    );
  }

  // Check if prop has an options function
  const optionsFn = prop.options;
  if (typeof optionsFn !== 'function') {
    throw new Error(
      `Property "${propertyName}" does not have a dynamic options function.`
    );
  }

  // Build propsValue — merge input with auth
  const propsValue = { ...input, auth };

  // Build context for the options function
  const ctx = {
    searchValue: searchValue || '',
    server: {
      apiUrl: '',
      publicUrl: '',
      token: '',
    },
  };

  // Call the options function
  const result = await optionsFn(propsValue, ctx);

  // Normalize the result — AP options functions return DropdownState
  if (result && typeof result === 'object') {
    const dropdownState = result as {
      options?: Array<{ label: string; value: unknown }>;
      disabled?: boolean;
      placeholder?: string;
    };

    return {
      options: (dropdownState.options || []).map((opt) => ({
        label: String(opt.label),
        value: opt.value,
      })),
      disabled: dropdownState.disabled,
      placeholder: dropdownState.placeholder,
    };
  }

  return { options: [] };
}
