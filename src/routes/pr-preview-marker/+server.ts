import { text } from "@sveltejs/kit";

/** #39 durable-record acceptance marker (task #39): proves the preview serves
 * PR-head code after the generation-fenced pipeline. Safe to merge or close. */
export const GET = () => text("d39-durable-marker-1");
