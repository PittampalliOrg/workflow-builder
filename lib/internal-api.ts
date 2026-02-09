export function isValidInternalToken(request: Request): boolean {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) {
    return false;
  }
  const token = request.headers.get("X-Internal-Token");
  return token === expected;
}
