/**
 * Pure screen-row motions: `gj` `gk` `g0` `g^` `g$` and `H` `M` `L`.
 * Rows are the prompt's wrapped display rows, as Pi lays them out.
 */

import type { Buffer, Pos } from "./engine.js";
import { clusters, type Span, width } from "./text.js";

/** One wrapped display row: `length` UTF-16 units of `line` from `start`. */
export type Row = { line: number; start: number; length: number };
/** The `height` rows the editor shows from row `top`. */
export type View = { top: number; height: number };

/** A cluster starting in a row, at display column `v` of that row. */
type Cell = { span: Span; v: number; w: number };
/** A row with the clusters that start in it; only these hold a cursor. */
type Stop = { index: number; line: number; cells: Cell[] };

const NO_PASTES: ReadonlySet<number> = new Set();

/**
 * Rows that can hold the cursor. A row inside a wrapped paste marker has no
 * cluster start and is skipped; an empty line is one stop at column 0. Cells
 * count display columns from the row's start, including the visible tail of
 * a marker that started on the row before.
 */
function stopsOf(buf: Buffer, rows: readonly Row[]): Stop[] {
  const measure = buf.measure ?? width;
  const size = (text: string) =>
    clusters(text, NO_PASTES).reduce(
      (sum, s) => sum + measure(text.slice(s.start, s.end)),
      0,
    );
  const stops: Stop[] = [];
  const cache = new Map<number, Span[]>();
  rows.forEach((row, index) => {
    const line = buf.lines[row.line] ?? "";
    let all = cache.get(row.line);
    if (!all) {
      all = clusters(line, buf.pastes);
      cache.set(row.line, all);
    }
    const end = row.start + row.length;
    const spans = all.filter((s) => s.start >= row.start && s.start < end);
    if (!spans.length && all.length) return;
    let v = spans.length ? size(line.slice(row.start, spans[0].start)) : 0;
    const cells = spans.map((span) => {
      const w = measure(line.slice(span.start, span.end));
      const cell = { span, v, w };
      v += w;
      return cell;
    });
    stops.push({ index, line: row.line, cells });
  });
  return stops;
}

/** The stop holding `pos`: the last one on its line starting at or before it. */
function stopAt(stops: Stop[], pos: Pos): number {
  let found = -1;
  stops.forEach((stop, i) => {
    if (stop.line !== pos.line) return;
    if (found === -1 || (stop.cells[0]?.span.start ?? 0) <= pos.col) found = i;
  });
  return Math.max(0, found);
}

const posOf = (stop: Stop, cell?: Cell): Pos => ({
  line: stop.line,
  col: cell?.span.start ?? 0,
});

/** First non-blank cluster of a stop; on a blank row, its last, as in Vim. */
function firstNonBlank(buf: Buffer, stop: Stop): Pos {
  const line = buf.lines[stop.line] ?? "";
  const cell = stop.cells.find(
    ({ span }) => !/^\s+$/.test(line.slice(span.start, span.end)),
  );
  return posOf(stop, cell ?? stop.cells.at(-1));
}

/**
 * Where a screen motion goes from the cursor, or undefined if it can't move.
 * `complete` is false when a count runs past the first or last row: the
 * cursor still moves as far as it can, but an operator does nothing, as in
 * Vim. `H`, `M`, and `L` need the editor's view and count from its edges.
 */
export function screenMotion(
  buf: Buffer,
  key: string,
  count: number,
): { to: Pos; complete: boolean } | undefined {
  const rows =
    buf.rows?.() ??
    buf.lines.map((l, line) => ({ line, start: 0, length: l.length }));
  const stops = stopsOf(buf, rows);
  if (!stops.length) return undefined;
  const at = stopAt(stops, buf.cursor);
  const here = stops[at];
  switch (key) {
    case "gj":
    case "gk": {
      const wanted = at + (key === "gj" ? count : -count);
      const target = Math.max(0, Math.min(stops.length - 1, wanted));
      if (target === at) return undefined;
      // Keep the display column within the row, like `j` and `k` do.
      const v = here.cells.find((c) => c.span.start === buf.cursor.col)?.v ?? 0;
      const to = stops[target];
      const cell = to.cells.find((c) => v < c.v + c.w) ?? to.cells.at(-1);
      return { to: posOf(to, cell), complete: target === wanted };
    }
    case "g0":
      return { to: posOf(here, here.cells[0]), complete: true };
    case "g^":
      return { to: firstNonBlank(buf, here), complete: true };
    case "g$": {
      // Vim still moves to the last row's end when the count runs past it.
      const to = stops[Math.min(stops.length - 1, at + count - 1)];
      return { to: posOf(to, to.cells.at(-1)), complete: true };
    }
    case "H":
    case "M":
    case "L": {
      const view = buf.view?.();
      if (!view) return undefined;
      const visible = stops.filter(
        (s) => s.index >= view.top && s.index < view.top + view.height,
      );
      if (!visible.length) return undefined;
      const n = Math.min(count, visible.length) - 1;
      const i =
        key === "H"
          ? n
          : key === "L"
            ? visible.length - 1 - n
            : // Vim's middle: the first of two, the third of five.
              Math.floor((visible.length + 1) / 2) - 1;
      return { to: firstNonBlank(buf, visible[i]), complete: true };
    }
  }
  return undefined;
}
