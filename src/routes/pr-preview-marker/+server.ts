import { text } from "@sveltejs/kit";

/** D1 live-validation marker (task #38): proves the preview serves PR-head code.
 * Safe to merge or close; the route is inert. */
export const GET = () => text("d1-marker-3548-e2e");
