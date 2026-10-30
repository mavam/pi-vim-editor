/**
 * Pure screen-row motions: `gj` `gk` `g0` `g^` `g$` and `H` `M` `L`.
 * Rows are the prompt's wrapped display rows, as Pi lays them out.
 */

import type { Buffer, Pos } from "./engine.js";
import { clusters, type Span, width } from "./text.js";

/** One wrapped display row: `length` UTF-16 units of `line` from `start`. */
export type Row = { line: number; start: number; length: number };
/** All wrapped rows, and the `height` rows Pi shows from row `top`. */
export type Screen = { rows: readonly Row[]; top: number; height: number };

/** A row with the clusters that start in it; only these hold a cursor. */
type Stop = { index: number; line: number; spans: Span[] };

/** Without a layout, each line is one row and every row is visible. */
function screenOf(buf: Buffer): Screen {
  const screen = buf.screen?.();
  if (screen?.rows.length) return screen;
  const rows = buf.lines.map((l, line) => ({
    line,
    start: 0,
    length: l.length,
  }));
  return { rows, top: 0, height: rows.length };
}

/**
 * Rows that can hold the cursor. A row inside a wrapped paste marker has no
 * cluster start and is skipped; an empty line is one stop at column 0.
 */
function stopsOf(buf: Buffer, rows: readonly Row[]): Stop[] {
  const stops: Stop[] = [];
  const cache = new Map<number, Span[]>();
  rows.forEach((row, index) => {
    let all = cache.get(row.line);
    if (!all) {
      all = clusters(buf.lines[row.line] ?? "", buf.pastes);
      cache.set(row.line, all);
    }
    const end = row.start + row.length;
    const spans = all.filter((s) => s.start >= row.start && s.start < end);
    if (spans.length || !all.length)
      stops.push({ index, line: row.line, spans });
  });
  return stops;
}

/** The stop holding `pos`: the last one on its line starting at or before it. */
function stopAt(stops: Stop[], pos: Pos): number {
  let found = -1;
  stops.forEach((stop, i) => {
    if (stop.line !== pos.line) return;
    if (found === -1 || (stop.spans[0]?.start ?? 0) <= pos.col) found = i;
  });
  return Math.max(0, found);
}

const posOf = (stop: Stop, span?: Span): Pos => ({
  line: stop.line,
  col: span?.start ?? 0,
});

function measureOf(buf: Buffer) {
  const measure = buf.measure ?? width;
  const line = (stop: Stop) => buf.lines[stop.line] ?? "";
  return (stop: Stop, span: Span) =>
    measure(line(stop).slice(span.start, span.end));
}

/** First non-blank cluster of a stop, else its first. */
function firstNonBlank(buf: Buffer, stop: Stop): Pos {
  const line = buf.lines[stop.line] ?? "";
  const span = stop.spans.find(
    (s) => !/^\s+$/.test(line.slice(s.start, s.end)),
  );
  return posOf(stop, span ?? stop.spans[0]);
}

/**
 * Where a screen motion goes from the cursor, or undefined if it can't move:
 * `gj`/`gk` past the last/first row. `{n}H` and `{n}L` count rows from the
 * top and bottom of the visible rows, clamped to them.
 */
export function screenMotion(
  buf: Buffer,
  key: string,
  count: number,
): Pos | undefined {
  const screen = screenOf(buf);
  const stops = stopsOf(buf, screen.rows);
  if (!stops.length) return undefined;
  const at = stopAt(stops, buf.cursor);
  const here = stops[at];
  const size = measureOf(buf);
  switch (key) {
    case "gj":
    case "gk": {
      const target = Math.max(
        0,
        Math.min(stops.length - 1, at + (key === "gj" ? count : -count)),
      );
      if (target === at) return undefined;
      // Keep the display column within the row, like `j` and `k` do.
      let v = 0;
      for (const span of here.spans) {
        if (span.start >= buf.cursor.col) break;
        v += size(here, span);
      }
      const to = stops[target];
      let x = 0;
      for (const span of to.spans) {
        const w = size(to, span);
        if (v < x + w) return posOf(to, span);
        x += w;
      }
      return posOf(to, to.spans.at(-1));
    }
    case "g0":
      return posOf(here, here.spans[0]);
    case "g^":
      return firstNonBlank(buf, here);
    case "g$": {
      const to = stops[at + count - 1];
      return to && posOf(to, to.spans.at(-1));
    }
    case "H":
    case "M":
    case "L": {
      const visible = visibleStops(screen, stops, stops[at].index);
      const n = Math.min(count, visible.length) - 1;
      const i =
        key === "H"
          ? n
          : key === "L"
            ? visible.length - 1 - n
            : // Vim's middle: the second of two, the third of five.
              Math.floor((visible.length + 1) / 2) - 1;
      return firstNonBlank(buf, visible[i]);
    }
  }
  return undefined;
}

/**
 * The stops Pi shows. Pi scrolls on render to keep the cursor's row visible;
 * a move since the last render may not have scrolled yet, so do it here.
 */
function visibleStops(screen: Screen, stops: Stop[], cursor: number): Stop[] {
  const height = Math.max(1, Math.min(screen.height, screen.rows.length));
  let top = Math.min(Math.max(0, screen.top), screen.rows.length - height);
  if (cursor < top) top = cursor;
  else if (cursor >= top + height) top = cursor - height + 1;
  // Never empty: the cursor's own stop is visible.
  return stops.filter((s) => s.index >= top && s.index < top + height);
}
