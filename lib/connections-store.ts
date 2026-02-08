import { atom } from "jotai";
import type { AppConnectionWithoutSensitiveData } from "./types/app-connection";

// Re-export the connection type for convenience
export type AppConnection = AppConnectionWithoutSensitiveData;

// Store for all user app connections
export const connectionsAtom = atom<AppConnection[]>([]);

// Track if connections have been loaded
export const connectionsLoadedAtom = atom(false);

// Version counter that increments when connections are added/deleted/modified
export const connectionsVersionAtom = atom(0);

// Derived atom to get all connection IDs
export const connectionIdsAtom = atom((get) => {
  const connections = get(connectionsAtom);
  return new Set(connections.map((c) => c.id));
});

// Derived: connections grouped by pieceName
export const connectionsByPieceAtom = atom((get) => {
  const connections = get(connectionsAtom);
  const grouped = new Map<string, AppConnection[]>();
  for (const conn of connections) {
    const list = grouped.get(conn.pieceName) ?? [];
    list.push(conn);
    grouped.set(conn.pieceName, list);
  }
  return grouped;
});
