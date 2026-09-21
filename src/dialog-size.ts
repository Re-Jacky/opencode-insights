export type DialogSize = "medium" | "large" | "xlarge";

const MEDIUM_MAX_ROWS = 10;
const LARGE_MAX_ROWS = 24;

/**
 * Picks the smallest dialog preset that fits `rowCount` lines, so the analysis
 * popup grows with its content instead of always rendering large.
 */
export function selectDialogSize(rowCount: number): DialogSize {
  if (rowCount <= MEDIUM_MAX_ROWS) return "medium";
  if (rowCount <= LARGE_MAX_ROWS) return "large";
  return "xlarge";
}
