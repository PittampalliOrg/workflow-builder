import { atom } from "jotai";

// Dedup set: tracks which notifications have been fired (format: `${executionId}:${type}`)
// Backed by sessionStorage so it survives React re-mounts and in-app navigation.
const NOTIFIED_SET_KEY = "workflow-notified-set";

function getStoredNotifiedSet(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = sessionStorage.getItem(NOTIFIED_SET_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    // ignore corrupt data
  }
  return new Set();
}

const notifiedSetBaseAtom = atom<Set<string>>(getStoredNotifiedSet());

export const notifiedSetAtom = atom(
  (get) => get(notifiedSetBaseAtom),
  (_get, set, value: Set<string>) => {
    set(notifiedSetBaseAtom, value);
    if (typeof window !== "undefined") {
      try {
        sessionStorage.setItem(
          NOTIFIED_SET_KEY,
          JSON.stringify(Array.from(value))
        );
      } catch {
        // storage full — ignore
      }
    }
  }
);

// Audio muted state — backed by localStorage
const AUDIO_MUTED_KEY = "workflow-notifications-audio-muted";

function getStoredMuted(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(AUDIO_MUTED_KEY) === "true";
}

export const audioMutedBaseAtom = atom<boolean>(getStoredMuted());

export const audioMutedAtom = atom(
  (get) => get(audioMutedBaseAtom),
  (_get, set, value: boolean) => {
    set(audioMutedBaseAtom, value);
    if (typeof window !== "undefined") {
      localStorage.setItem(AUDIO_MUTED_KEY, String(value));
    }
  }
);
