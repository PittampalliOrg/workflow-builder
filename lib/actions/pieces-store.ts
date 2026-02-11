"use client";

import { atom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo } from "react";
import { api } from "@/lib/api-client";
import { LEGACY_ACTION_MAPPINGS } from "@/lib/actions/legacy-action-mappings";
import {
	normalizePlannerActionType,
	withPlannerPiece,
} from "@/lib/actions/planner-actions";
import type {
	ActionDefinition,
	IntegrationDefinition,
	IntegrationType,
} from "@/lib/actions/types";
import { computeActionId } from "@/lib/actions/utils";

type PiecesState = {
	pieces: IntegrationDefinition[];
	loaded: boolean;
	loading: boolean;
	error: string | null;
};

const piecesStateAtom = atom<PiecesState>({
	pieces: [],
	loaded: false,
	loading: false,
	error: null,
});

async function loadPiecesCatalog(): Promise<IntegrationDefinition[]> {
	const pieceApi = (
		api as unknown as {
			piece?: { actions?: () => Promise<{ pieces: IntegrationDefinition[] }> };
		}
	).piece;

	let primaryError: unknown;

	// Prefer typed API client when available.
	if (typeof pieceApi?.actions === "function") {
		try {
			const response = await pieceApi.actions();
			const pieces = Array.isArray(response?.pieces) ? response.pieces : [];
			return withPlannerPiece(pieces);
		} catch (error) {
			primaryError = error;
		}
	}

	// Fallback for runtime shape mismatches (e.g. stale HMR module graph).
	try {
		const response = await fetch("/api/pieces/actions");
		if (!response.ok) {
			throw new Error(`Failed to load pieces (HTTP ${response.status})`);
		}

		const data = (await response.json()) as {
			pieces?: IntegrationDefinition[];
		};
		const pieces = Array.isArray(data?.pieces) ? data.pieces : [];
		return withPlannerPiece(pieces);
	} catch {
		if (primaryError instanceof Error) {
			throw primaryError;
		}
		throw new Error("Failed to load pieces");
	}
}

function buildActionIndex(
	pieces: IntegrationDefinition[],
): Map<string, ActionDefinition> {
	const actions = new Map<string, ActionDefinition>();

	for (const piece of pieces) {
		for (const action of piece.actions) {
			const id = computeActionId(piece.type, action.slug);
			actions.set(id, {
				...action,
				id,
				integration: piece.type,
			});
		}
	}

	return actions;
}

function buildIntegrationIndex(
	pieces: IntegrationDefinition[],
): Map<IntegrationType, IntegrationDefinition> {
	return new Map(pieces.map((p) => [p.type, p]));
}

function mergeCatalogPieces(
	current: IntegrationDefinition[],
	incoming: IntegrationDefinition[],
): IntegrationDefinition[] {
	if (incoming.length === 0) {
		return current;
	}

	const merged = new Map(current.map((piece) => [piece.type, piece]));

	for (const nextPiece of incoming) {
		const existing = merged.get(nextPiece.type);
		if (!existing) {
			merged.set(nextPiece.type, nextPiece);
			continue;
		}

		const actionsBySlug = new Map(
			existing.actions.map((action) => [action.slug, action]),
		);
		for (const action of nextPiece.actions) {
			actionsBySlug.set(action.slug, action);
		}

		merged.set(nextPiece.type, {
			...existing,
			...nextPiece,
			actions: Array.from(actionsBySlug.values()),
		});
	}

	return Array.from(merged.values()).sort((a, b) =>
		a.label.localeCompare(b.label),
	);
}

export function usePiecesCatalog() {
	const state = useAtomValue(piecesStateAtom);
	const setState = useSetAtom(piecesStateAtom);

	useEffect(() => {
		if (state.loaded || state.loading) {
			return;
		}

		setState((s) => ({ ...s, loading: true, error: null }));

		void loadPiecesCatalog()
			.then((pieces) => {
				setState({
					pieces,
					loaded: true,
					loading: false,
					error: null,
				});
			})
			.catch((err) => {
				setState((s) => ({
					...s,
					loaded: true,
					loading: false,
					error: err instanceof Error ? err.message : "Failed to load pieces",
				}));
			});
	}, [setState, state.loaded, state.loading]);

	const integrationsByType = useMemo(
		() => buildIntegrationIndex(state.pieces),
		[state.pieces],
	);
	const actionsById = useMemo(
		() => buildActionIndex(state.pieces),
		[state.pieces],
	);

	const findActionById = useCallback(
		(actionId: string | undefined | null): ActionDefinition | undefined => {
			if (!actionId) return;

			const legacyMapped = LEGACY_ACTION_MAPPINGS[actionId] ?? actionId;
			const normalized = normalizePlannerActionType(legacyMapped);
			return actionsById.get(normalized);
		},
		[actionsById],
	);

	const getIntegration = useCallback(
		(
			type: IntegrationType | undefined | null,
		): IntegrationDefinition | undefined => {
			if (!type) return;
			return integrationsByType.get(type);
		},
		[integrationsByType],
	);

	const getIntegrationLabels = useCallback((): Record<string, string> => {
		const labels: Record<string, string> = {};
		for (const piece of state.pieces) {
			labels[piece.type] = piece.label;
		}
		return labels;
	}, [state.pieces]);

	const mergePieces = useCallback(
		(pieces: IntegrationDefinition[]) => {
			if (pieces.length === 0) {
				return;
			}
			setState((s) => ({
				...s,
				pieces: withPlannerPiece(mergeCatalogPieces(s.pieces, pieces)),
			}));
		},
		[setState],
	);

	return {
		pieces: state.pieces,
		loaded: state.loaded,
		loading: state.loading,
		error: state.error,
		actionsById,
		integrationsByType,
		findActionById,
		getIntegration,
		getIntegrationLabels,
		mergePieces,
	};
}
