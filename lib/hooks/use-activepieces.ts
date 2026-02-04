/**
 * useActivePieces Hook
 *
 * Fetches and manages ActivePieces data for the UI.
 */
"use client";

import { useEffect, useState } from "react";

/**
 * ActivePieces action from API
 */
export interface ActivePiecesAction {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  inputSchema: unknown;
}

/**
 * ActivePieces piece with actions
 */
export interface ActivePiecesPiece {
  name: string;
  displayName: string;
  actions: ActivePiecesAction[];
}

/**
 * API response shape
 */
interface ActivePiecesResponse {
  success: boolean;
  pieces: ActivePiecesPiece[];
  totalPieces: number;
  totalActions: number;
  error?: string;
}

/**
 * Hook state
 */
interface UseActivePiecesState {
  pieces: ActivePiecesPiece[];
  loading: boolean;
  error: string | null;
  totalPieces: number;
  totalActions: number;
}

/**
 * Fetch ActivePieces from the API
 */
export function useActivePieces(options?: { search?: string }): UseActivePiecesState {
  const [state, setState] = useState<UseActivePiecesState>({
    pieces: [],
    loading: true,
    error: null,
    totalPieces: 0,
    totalActions: 0,
  });

  useEffect(() => {
    let cancelled = false;

    async function fetchPieces() {
      try {
        setState((s) => ({ ...s, loading: true, error: null }));

        const params = new URLSearchParams();
        if (options?.search) {
          params.set("search", options.search);
        }

        const url = `/api/activepieces/pieces${params.toString() ? `?${params}` : ""}`;
        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data: ActivePiecesResponse = await response.json();

        if (cancelled) return;

        if (!data.success) {
          throw new Error(data.error || "Failed to fetch ActivePieces");
        }

        setState({
          pieces: data.pieces,
          loading: false,
          error: null,
          totalPieces: data.totalPieces,
          totalActions: data.totalActions,
        });
      } catch (error) {
        if (cancelled) return;

        setState((s) => ({
          ...s,
          loading: false,
          error: error instanceof Error ? error.message : "Unknown error",
        }));
      }
    }

    fetchPieces();

    return () => {
      cancelled = true;
    };
  }, [options?.search]);

  return state;
}

/**
 * Get a flattened list of all AP actions for use in selectors
 * Returns actions in the format expected by the action selector
 */
export function flattenActivePiecesActions(
  pieces: ActivePiecesPiece[]
): Array<{ id: string; label: string; slug: string; pieceName: string }> {
  const actions: Array<{ id: string; label: string; slug: string; pieceName: string }> = [];

  for (const piece of pieces) {
    for (const action of piece.actions) {
      actions.push({
        id: action.slug, // Use slug as the id (e.g., "ap-slack/send_message")
        label: action.name,
        slug: action.slug,
        pieceName: piece.name,
      });
    }
  }

  return actions;
}

/**
 * Build category data structure for AP pieces
 * Returns a map of piece display names to their actions
 */
export function buildActivePiecesCategories(
  pieces: ActivePiecesPiece[]
): Record<string, Array<{ id: string; label: string }>> {
  const categories: Record<string, Array<{ id: string; label: string }>> = {};

  for (const piece of pieces) {
    const categoryName = `AP: ${piece.displayName}`;
    categories[categoryName] = piece.actions.map((action) => ({
      id: action.slug,
      label: action.name,
    }));
  }

  return categories;
}

/**
 * Check if an action ID is an ActivePieces action
 */
export function isActivePiecesAction(actionId: string): boolean {
  return actionId.startsWith("ap-");
}

/**
 * Extract piece name from AP action ID
 * e.g., "ap-slack/send_message" -> "slack"
 */
export function extractPieceFromActionId(actionId: string): string | null {
  if (!isActivePiecesAction(actionId)) {
    return null;
  }

  const match = actionId.match(/^ap-([^/]+)\//);
  return match ? match[1] : null;
}

/**
 * Get the integration type for an AP piece
 */
export function getActivePiecesIntegrationType(pieceName: string): string {
  // Map common piece names to our integration types
  const mapping: Record<string, string> = {
    slack: "slack",
    github: "github",
    openai: "openai",
    gmail: "google",
    "google-sheets": "google",
    "google-drive": "google",
    "google-calendar": "google",
    "google-docs": "google",
    notion: "notion",
    stripe: "stripe",
    hubspot: "hubspot",
    salesforce: "salesforce",
    linear: "linear",
    // Add more as needed
  };

  return mapping[pieceName] || `activepieces-${pieceName}`;
}
