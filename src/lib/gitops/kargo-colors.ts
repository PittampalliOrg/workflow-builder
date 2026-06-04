/**
 * Deterministic identity colour assignment ported from Kargo's open-source UI
 * (Apache-2.0, akuity/kargo: ui/src/features/stage/utils/index.ts).
 *
 * Kargo gives every Stage and Warehouse a stable colour from a fixed palette so
 * the graph edges, stage headers, and freight "in-use" bars all share one
 * identity hue. We reuse the same palettes and round-robin assignment, keyed by
 * service/warehouse name, and persist to localStorage so colours stay stable
 * across reloads (mirrors Kargo's getColors/setColors).
 */

/** Stage / freight identity palette (21 colours), verbatim from Kargo. */
export const ColorMapHex: Record<string, string> = {
	red: "#ED204E",
	salmon: "#FD5352",
	orange: "#FE7537",
	amber: "#e78a00",
	yellow: "#DFC546",
	lime: "#9bce22",
	avocado: "#84DF75",
	green: "#1CAC77",
	teal: "#1bc1a7",
	cyan: "#1DCECA",
	sky: "#0DAFD3",
	blue: "#3882EA",
	indigo: "#2D5EDC",
	periwinkle: "#6380E1",
	violet: "#7851AA",
	purple: "#A9499D",
	fuchsia: "#D0469D",
	pink: "#E573A2",
	rose: "#f1619b",
	dragonfruit: "#FE43A3",
	gray: "#6a7382",
};

/** Warehouse identity palette (12 deeper colours), verbatim from Kargo. */
export const WarehouseColorMapHex: Record<string, string> = {
	red: "#D70015",
	orange: "#C93500",
	yellow: "#B24F01",
	green: "#248A3D",
	mint: "#0E817C",
	teal: "#028299",
	cyan: "#0471A4",
	blue: "#013fDC",
	indigo: "#3634A3",
	purple: "#8944AA",
	pink: "#D21043",
	brown: "#7F6545",
};

export type ColorMap = Record<string, string>;

/**
 * Assign a stable colour to each name. Names already present in `prevMap` keep
 * their colour; new names get the next palette colour by a deterministic stride
 * (Kargo's `generateStageColors` round-robin).
 */
export function generateColors(
	names: string[],
	prevMap: ColorMap = {},
	palette: Record<string, string> = ColorMapHex,
): ColorMap {
	const finalMap: ColorMap = { ...prevMap };
	const used = new Set(Object.values(finalMap));
	const available = Object.values(palette).filter((hex) => !used.has(hex));
	const pool = available.length > 0 ? available : Object.values(palette);

	const remaining = names.filter((name) => name && !finalMap[name]);
	const step = Math.max(1, Math.floor(pool.length / Math.max(1, remaining.length)));

	let i = 0;
	for (const name of remaining) {
		finalMap[name] = pool[i % pool.length];
		i += step;
	}
	return finalMap;
}

/**
 * localStorage-backed variant: reuses the stored map when the name-set is
 * unchanged, otherwise regenerates while preserving existing assignments.
 * Safe on the server (no-ops to in-memory generation when localStorage absent).
 */
export function getColors(
	storageKey: string,
	names: string[],
	palette: Record<string, string> = ColorMapHex,
): ColorMap {
	const sorted = [...names].sort((a, b) => a.localeCompare(b));
	let prev: ColorMap = {};

	const ls = typeof localStorage !== "undefined" ? localStorage : null;
	if (ls) {
		const raw = ls.getItem(storageKey);
		if (raw) {
			try {
				const stored = JSON.parse(raw) as ColorMap;
				if (Object.keys(stored).length === sorted.length && sorted.every((n) => stored[n])) {
					return stored;
				}
				prev = stored;
			} catch {
				prev = {};
			}
		}
	}

	const map = generateColors(sorted, prev, palette);
	if (ls) {
		try {
			ls.setItem(storageKey, JSON.stringify(map));
		} catch {
			/* ignore quota / privacy-mode errors */
		}
	}
	return map;
}
