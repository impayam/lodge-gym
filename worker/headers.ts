// SPEC §13 security headers, applied to every response. SPEC-v6 §2 (approved by Payam): 'wasm-unsafe-eval' lets the
// self-hosted Draco decoder compile its WebAssembly (JS eval and new Function stay blocked), and worker-src blob: lets
// DRACOLoader start its decoder worker, which it builds from that decoder file; 'self' keeps the service worker.
export const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'";

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
