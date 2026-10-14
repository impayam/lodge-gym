// Design tokens (web/src/styles/tokens.css) read at runtime, for colors drawn outside CSS: canvas, WebGL and chart
// code. Nothing in web/src hard-codes a color (SPEC-v8 §2.1).

/** The current value of a CSS custom property on the root element, trimmed. */
export function token(name: `--${string}`): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
