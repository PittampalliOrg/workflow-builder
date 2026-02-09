"use client";

import { useEffect, useState } from "react";

export type SessionUser = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  platformId: string;
  projectId: string;
};

type SessionData = {
  user: SessionUser;
} | null;

// Global session state (shared across all useSession hooks)
let globalSession: SessionData = null;
let globalLoading = true;
let listeners: Array<() => void> = [];

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

async function tryRefreshToken(): Promise<boolean> {
  try {
    const response = await fetch("/api/v1/auth/refresh", { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}

async function fetchSession(): Promise<SessionData> {
  try {
    let response = await fetch("/api/v1/auth/me");

    // If access token expired, try refreshing
    if (response.status === 401) {
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        response = await fetch("/api/v1/auth/me");
      }
    }

    if (!response.ok) return null;
    const data = await response.json();
    return { user: data.user };
  } catch {
    return null;
  }
}

async function initSession() {
  globalSession = await fetchSession();
  globalLoading = false;
  notifyListeners();
}

// Initialize session on module load (client-side only)
if (typeof window !== "undefined") {
  initSession();
}

export function useSession(): { data: SessionData; isPending: boolean } {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const listener = () => forceUpdate((n) => n + 1);
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }, []);

  return { data: globalSession, isPending: globalLoading };
}

export const signIn = {
  email: async (params: { email: string; password: string }) => {
    const response = await fetch("/api/v1/auth/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });

    const data = await response.json();
    if (!response.ok) {
      return { error: { message: data.error || "Sign in failed" } };
    }

    globalSession = { user: data.user };
    globalLoading = false;
    notifyListeners();
    return { error: null, data };
  },

  social: (params: { provider: string; callbackURL?: string }) => {
    // Navigate to OAuth initiation endpoint
    window.location.href = `/api/v1/auth/social/${params.provider}`;
  },
};

export const signUp = {
  email: async (params: { email: string; password: string; name: string }) => {
    const response = await fetch("/api/v1/auth/sign-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });

    const data = await response.json();
    if (!response.ok) {
      return { error: { message: data.error || "Sign up failed" } };
    }

    globalSession = { user: data.user };
    globalLoading = false;
    notifyListeners();
    return { error: null, data };
  },
};

export async function signOut() {
  await fetch("/api/v1/auth/sign-out", { method: "POST" });
  globalSession = null;
  globalLoading = false;
  notifyListeners();
  window.location.href = "/";
}

// Re-export for backwards compatibility
export const authClient = { signIn, signOut, signUp };
