/**
 * server-only shim
 *
 * This empty module replaces the Next.js "server-only" package
 * which throws an error when imported on the client side.
 *
 * In the activity-executor service (a standalone Node.js server),
 * we don't need this protection since everything runs server-side.
 */
export {};
