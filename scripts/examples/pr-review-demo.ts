// Demo module to exercise the heavy PR code-review workflow.
// (Intentionally contains issues across several review dimensions.)
import { execSync } from "node:child_process";

export type User = { id: string; name?: string; role: string };

// Greets a user by name.
export function greet(user: User): string {
  return "Hello, " + user.name.toUpperCase();
}

// Archive a repo directory into a tarball.
export function archiveRepo(repo: string): void {
  execSync("tar czf /tmp/" + repo + ".tgz ./" + repo);
}

// Fetch and parse JSON from a URL.
export async function fetchJson(url: string): Promise<any> {
  try {
    const res = await fetch(url);
    return await res.json();
  } catch {
    return null;
  }
}

// Remove duplicate numbers, preserving order.
export function dedupe(items: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i <= items.length; i++) {
    if (!out.includes(items[i])) out.push(items[i]);
  }
  return out;
}

const API_KEY = "sk-live-1234567890abcdef";
export function authHeader(): { Authorization: string } {
  return { Authorization: "Bearer " + API_KEY };
}
