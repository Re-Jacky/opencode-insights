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

/** Rows the dialog spends above its content. */
const HEADER_ROWS = 1; // "Session Analysis" + esc
const TOP_PADDING_ROWS = 1; // spacing under the dialog's top edge
/** The scrollbox keeps a row for its scrollbars even when they are hidden. */
const SCROLL_RESERVED_ROWS = 1;
/** Padding the scrollbox forwards to its content, so rows start clear of the header. */
const SCROLL_PADDING_ROWS = 1;
const CHROME_ROWS = HEADER_ROWS + TOP_PADDING_ROWS + SCROLL_RESERVED_ROWS + SCROLL_PADDING_ROWS;
/** Keeps the dialog clear of the bottom edge (the host starts it at height / 4). */
const BOTTOM_MARGIN_ROWS = 3;

export type AnalysisDialogLayout = {
  /** Visible content rows, i.e. what the scrollbox shows before scrolling. */
  rowHeight: number;
  /** Height for the scrollbox: its content, its padding, and its reserved row. */
  scrollHeight: number;
  /** Height for the dialog's root box. */
  height: number;
};

/**
 * Sizes the analysis dialog to its content.
 *
 * The host's dialog box is content sized, but a scrollbox with no height expands
 * to fill the whole full-screen overlay, which made the popup reach the bottom no
 * matter how short the content was. Both heights therefore have to be explicit;
 * anything longer than the terminal allows is capped and left to scroll.
 */
export function selectAnalysisDialogLayout(rowCount: number, screenHeight: number): AnalysisDialogLayout {
  const screen = Number.isFinite(screenHeight) ? Math.max(0, Math.floor(screenHeight)) : 0;
  const available = Math.max(1, screen - Math.floor(screen / 4) - BOTTOM_MARGIN_ROWS);
  const maxRowHeight = Math.max(1, available - CHROME_ROWS);
  const rowHeight = Math.min(Math.max(1, Math.floor(rowCount)), maxRowHeight);
  return {
    rowHeight,
    scrollHeight: rowHeight + SCROLL_PADDING_ROWS + SCROLL_RESERVED_ROWS,
    height: rowHeight + CHROME_ROWS
  };
}
