// SPEC §13 security headers, applied to every response.
export const CSP = "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'";

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
