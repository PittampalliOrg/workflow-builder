"use client";

import { useCallback, useEffect, useState } from "react";
import type {
	DiffContentMode,
	DiffPreferences,
	DiffViewMode,
} from "@/lib/diff/types";

const DIFF_PREFERENCES_KEY = "workflow-run-diff-preferences";

const DEFAULT_PREFERENCES: DiffPreferences = {
	viewMode: "unified",
	contentMode: "incremental",
};

function savePreferencesToLocalStorage(prefs: DiffPreferences): void {
	try {
		localStorage.setItem(DIFF_PREFERENCES_KEY, JSON.stringify(prefs));
	} catch (error) {
		console.warn("Failed to save diff preferences:", error);
	}
}

function getPreferencesFromLocalStorage(): DiffPreferences {
	try {
		const stored = localStorage.getItem(DIFF_PREFERENCES_KEY);
		if (stored) {
			const parsed = JSON.parse(stored);
			if (
				parsed &&
				(parsed.viewMode === "unified" || parsed.viewMode === "split") &&
				(parsed.contentMode === "incremental" || parsed.contentMode === "full")
			) {
				return parsed as DiffPreferences;
			}
		}
		return DEFAULT_PREFERENCES;
	} catch (error) {
		console.warn("Failed to retrieve diff preferences:", error);
		return DEFAULT_PREFERENCES;
	}
}

export interface UseDiffPreferencesReturn {
	viewMode: DiffViewMode;
	contentMode: DiffContentMode;
	setViewMode: (mode: DiffViewMode) => void;
	setContentMode: (mode: DiffContentMode) => void;
}

export function useDiffPreferences(): UseDiffPreferencesReturn {
	const [preferences, setPreferences] =
		useState<DiffPreferences>(DEFAULT_PREFERENCES);

	useEffect(() => {
		setPreferences(getPreferencesFromLocalStorage());
	}, []);

	const setViewMode = useCallback((mode: DiffViewMode) => {
		setPreferences((prev) => {
			const next = { ...prev, viewMode: mode };
			savePreferencesToLocalStorage(next);
			return next;
		});
	}, []);

	const setContentMode = useCallback((mode: DiffContentMode) => {
		setPreferences((prev) => {
			const next = { ...prev, contentMode: mode };
			savePreferencesToLocalStorage(next);
			return next;
		});
	}, []);

	return {
		viewMode: preferences.viewMode,
		contentMode: preferences.contentMode,
		setViewMode,
		setContentMode,
	};
}
