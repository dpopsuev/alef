/**
 * Theme re-exports for tui/ components.
 *
 * tui/ imports from this shim instead of ../theme.js, breaking the
 * runner/src ↔ runner/src/tui directory cycle. The parent theme.ts
 * remains the canonical implementation — nothing is duplicated.
 */
export { bg, bold, color, dim, glyph, italic } from "./ansi.js";
