/**
 * The only module that touches private members of pi-tui's `Editor`.
 * See docs/design.md §6 and the upstream asks in docs/upstream.md.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { type Buffer, type Pos, splice } from "./engine.js";
import type { Row, View } from "./screen.js";

export type Port = {
  read(): Buffer;
  setCursor(pos: Pos): void;
  /** Replace a range as one undo step. */
  replace(from: Pos, to: Pos, text: string, cursor: Pos): void;
  /** Undo, keeping what it undid for `redo()`. */
  undo(): void;
  /** Redo the last undo; false if there's nothing to redo. */
  redo(): boolean;
  /** Forget what can be redone, e.g. after another edit. */
  clearRedo(): void;
  /** Number of undo steps on Pi's undo stack. */
  undoDepth(): number;
  /** Merge all undo steps after `depth + 1` into that one step. */
  collapseUndo(depth: number): void;
  autocompleteOpen(): boolean;
  /** The content of each pasted block, by id. */
  pastes(): ReadonlyMap<number, string>;
  /** Register `content` as a new pasted block; its marker, as Pi writes it. */
  paste(content: string): string;
  closeAutocomplete(): void;
  /** End Pi's pending character jump (`Ctrl-]`), if any. */
  cancelJump(): void;
  /**
   * The rows Pi rendered last, as logical-line segments, for highlighting a
   * Visual selection. Undefined if the editor's layout internals don't match.
   */
  layout?(width: number): Layout;
  /** All wrapped rows, as Pi's own up and down keys see them. */
  rows?(): Row[];
  /**
   * The rows Pi's next render shows. Scrolls Pi's view to the cursor first,
   * as that render would.
   */
  view?(): View;
};

export type Layout = {
  padding: number;
  rows: { line: number; start: number; length: number }[];
};

type Segment = { logicalLine: number; startCol: number; length: number };

type Internals = {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  pastes: Map<number, string>;
  pasteCounter: number;
  lastAction: unknown;
  undoStack: { length: number; pop(): unknown; push(state: unknown): void };
  jumpMode?: unknown;
  onChange?: (text: string) => void;
  getText(): string;
  isShowingAutocomplete(): boolean;
  setCursorCol(col: number): void;
  pushUndoSnapshot(): void;
  undo(): void;
  exitHistoryBrowsing(): void;
  cancelAutocomplete(): void;
  getPaddingX?(): number;
  buildVisualLineMap?(width: number): Segment[];
  lastWidth?: number;
  scrollOffset?: number;
  renderedVisibleLineCount?: number;
  tui?: { terminal?: { rows?: number } };
};

const METHODS = [
  "getText",
  "isShowingAutocomplete",
  "setCursorCol",
  "pushUndoSnapshot",
  "undo",
  "exitHistoryBrowsing",
  "cancelAutocomplete",
] as const;

/** Adapter over an editor, or undefined if its internals don't match. */
export function portFor(editor: object): Port | undefined {
  const e = editor as Internals;
  const state = e.state as Partial<Internals["state"]> | undefined;
  const compatible =
    Array.isArray(state?.lines) &&
    typeof state.cursorLine === "number" &&
    typeof state.cursorCol === "number" &&
    e.pastes instanceof Map &&
    typeof e.pasteCounter === "number" &&
    "lastAction" in e &&
    typeof e.undoStack?.length === "number" &&
    typeof e.undoStack.pop === "function" &&
    typeof e.undoStack.push === "function" &&
    METHODS.every((name) => typeof e[name] === "function");
  if (!compatible) return undefined;
  const layout =
    typeof e.buildVisualLineMap === "function" &&
    typeof e.getPaddingX === "function" &&
    typeof e.lastWidth === "number" &&
    typeof e.scrollOffset === "number" &&
    typeof e.renderedVisibleLineCount === "number"
      ? (width: number): Layout => {
          // Same padding clamp as Editor.render().
          const max = Math.max(0, Math.floor((width - 1) / 2));
          const padding = Math.min(e.getPaddingX?.() ?? 0, max);
          const map = e.buildVisualLineMap?.(e.lastWidth ?? width) ?? [];
          const top = e.scrollOffset ?? 0;
          const rows = map
            .slice(top, top + (e.renderedVisibleLineCount ?? 0))
            .map((s) => ({
              line: s.logicalLine,
              start: s.startCol,
              length: s.length,
            }));
          return { padding, rows };
        }
      : undefined;
  // Pi wraps rows at `lastWidth`, its layout width from the last render, and
  // moves its own cursor up and down by the same map.
  const rows =
    typeof e.buildVisualLineMap === "function" &&
    typeof e.lastWidth === "number"
      ? (): Row[] =>
          (e.buildVisualLineMap?.(e.lastWidth ?? 80) ?? []).map((s) => ({
            line: s.logicalLine,
            start: s.startCol,
            length: s.length,
          }))
      : undefined;
  const view =
    rows &&
    typeof e.scrollOffset === "number" &&
    typeof e.renderedVisibleLineCount === "number"
      ? (): View => {
          const all = rows();
          const { cursorLine, cursorCol } = e.state;
          let cursor = 0;
          all.forEach((row, i) => {
            if (row.line === cursorLine && row.start <= cursorCol) cursor = i;
          });
          // Same capacity and scrolling as Editor.render(). The text or the
          // cursor may have changed since it last ran.
          const terminal = e.tui?.terminal?.rows;
          const capacity =
            typeof terminal === "number"
              ? Math.max(5, Math.floor(terminal * 0.3))
              : Math.max(1, e.renderedVisibleLineCount ?? 1);
          let top = e.scrollOffset ?? 0;
          if (cursor < top) top = cursor;
          else if (cursor >= top + capacity) top = cursor - capacity + 1;
          top = Math.max(0, Math.min(top, all.length - capacity));
          // Keep it, so the next render shows what the motion saw, even if
          // several motions run before it.
          e.scrollOffset = top;
          return { top, height: Math.min(capacity, all.length - top) };
        }
      : undefined;
  // Pi's editor has no redo: keep the state each undo replaced.
  type Snapshot = {
    lines: string[];
    pastes: Map<number, string>;
    pasteCounter: number;
  };
  const redos: Snapshot[] = [];
  const snapshot = (): Snapshot => ({
    lines: [...e.state.lines],
    pastes: new Map(e.pastes),
    pasteCounter: e.pasteCounter,
  });
  const setCursor = (pos: Pos) => {
    e.state.cursorLine = pos.line;
    e.setCursorCol(pos.col);
    // Like Pi's own cursor moves: typing afterward starts a new undo step.
    e.lastAction = null;
  };
  return {
    read: () => ({
      lines: [...e.state.lines],
      cursor: { line: e.state.cursorLine, col: e.state.cursorCol },
      pastes: new Set(e.pastes.keys()),
      measure: visibleWidth,
    }),
    setCursor,
    replace(from, to, text, cursor) {
      // Same bookkeeping as the public Editor.insertTextAtCursor().
      e.cancelAutocomplete();
      e.pushUndoSnapshot();
      e.lastAction = null;
      e.exitHistoryBrowsing();
      e.state.lines = splice(e.state.lines, from, to, text);
      setCursor(cursor);
      e.onChange?.(e.getText());
    },
    undo() {
      if (!e.undoStack.length) return;
      redos.push(snapshot());
      e.undo();
    },
    redo() {
      const next = redos.pop();
      if (!next) return false;
      const before = [...e.state.lines];
      // Like any edit: the current state becomes one undo step.
      e.cancelAutocomplete();
      e.pushUndoSnapshot();
      e.exitHistoryBrowsing();
      e.state.lines = next.lines;
      e.pastes = next.pastes;
      e.pasteCounter = next.pasteCounter;
      // Vim puts the cursor where the redone change starts.
      setCursor(firstDifference(before, next.lines));
      e.onChange?.(e.getText());
      return true;
    },
    clearRedo: () => {
      redos.length = 0;
    },
    undoDepth: () => e.undoStack.length,
    collapseUndo(depth) {
      // The snapshot at `depth` holds the state before the whole change;
      // the newer ones only split it.
      while (e.undoStack.length > depth + 1) e.undoStack.pop();
    },
    autocompleteOpen: () => e.isShowingAutocomplete(),
    pastes: () => new Map(e.pastes),
    paste(content) {
      e.pasteCounter++;
      const id = e.pasteCounter;
      e.pastes.set(id, content);
      const lines = content.split("\n").length;
      return lines > 10
        ? `[paste #${id} +${lines} lines]`
        : `[paste #${id} ${content.length} chars]`;
    },
    closeAutocomplete: () => e.cancelAutocomplete(),
    cancelJump: () => {
      if ("jumpMode" in e) e.jumpMode = null;
    },
    layout,
    rows,
    view,
  };
}

/** Where `after` first differs from `before`, as a position in `after`. */
function firstDifference(before: string[], after: string[]): Pos {
  for (let line = 0; line < after.length; line++) {
    const a = before[line] ?? "";
    const b = after[line];
    if (a === b && line < before.length) continue;
    let col = 0;
    while (col < b.length && a[col] === b[col]) col++;
    return { line, col: Math.min(col, b.length) };
  }
  const line = after.length - 1;
  return { line, col: after[line].length };
}
