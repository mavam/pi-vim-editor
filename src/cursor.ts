import { CURSOR_MARKER, type TUI } from "@earendil-works/pi-tui";
import type { Mode } from "./engine.js";

export type Cursor = {
  render(mode: Mode, lines: string[]): void;
  dispose(): void;
};

/** The DECSCUSR parameter for every mode. */
export type CursorShapes = Readonly<Record<Mode, number>>;

/** DECSCUSR parameters by name; `reset` is the terminal's default. */
const STYLES: Readonly<Record<string, number>> = {
  reset: 0,
  "blinking-block": 1,
  "steady-block": 2,
  "blinking-underline": 3,
  "steady-underline": 4,
  "blinking-bar": 5,
  "steady-bar": 6,
};

/** User-facing keys; `visual` covers all three Visual modes. */
const KEYS: Readonly<Record<string, readonly Mode[]>> = {
  insert: ["insert"],
  normal: ["normal"],
  visual: ["visual", "vline", "vblock"],
  replace: ["replace"],
};

const DEFAULTS: CursorShapes = {
  insert: 6,
  normal: 2,
  visual: 2,
  vline: 2,
  vblock: 2,
  replace: 4,
};

/**
 * `vimEditor.cursorShape` from Pi's settings: `true` selects the defaults, a
 * map overrides them per mode, and anything else disables cursor shapes.
 */
export function cursorShapes(value: unknown): CursorShapes | undefined {
  if (value === true) return DEFAULTS;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const shapes = { ...DEFAULTS };
  for (const [key, modes] of Object.entries(KEYS)) {
    const style = (value as Record<string, unknown>)[key];
    if (typeof style !== "string" || !Object.hasOwn(STYLES, style)) continue;
    for (const mode of modes) shapes[mode] = STYLES[style];
  }
  return shapes;
}

/** Own the cursor shape only while this editor has a visible hardware cursor. */
export function cursorFor(
  editor: object,
  tui: TUI,
  shapes: CursorShapes,
): Cursor | undefined {
  const target = editor as { focused: boolean };
  const terminal = tui.terminal;
  const focus = Object.getOwnPropertyDescriptor(editor, "focused");
  if (
    !focus?.configurable ||
    typeof target.focused !== "boolean" ||
    ("value" in focus ? !focus.writable : !focus.get || !focus.set) ||
    typeof tui.getShowHardwareCursor !== "function" ||
    typeof terminal.write !== "function" ||
    typeof terminal.start !== "function" ||
    typeof terminal.stop !== "function"
  )
    return undefined;

  let disposed = false;
  // Pi starts the terminal before installing editor factories.
  let running = true;
  let focused = target.focused;
  let shape: number | undefined;
  const reset = () => {
    if (shape === undefined) return;
    // DECSCUSR 0: the terminal default, not the unknown pre-Pi style.
    terminal.write("\x1b[0 q");
    shape = undefined;
  };
  const get = () => (focus.get ? focus.get.call(editor) : focused);
  const set = (value: boolean) => {
    if (focus.set) focus.set.call(editor, value);
    else focused = value;
    // Dialogs can unmount the prompt entirely: waiting for render is too late.
    if (!disposed && !get()) reset();
  };
  Object.defineProperty(editor, "focused", {
    configurable: true,
    enumerable: focus.enumerable,
    get,
    set,
  });

  // The terminal survives renderer switches; the TUI itself is a moving proxy.
  const start = terminal.start;
  const stop = terminal.stop;
  // Usually prototype methods: restore by deleting the instance override.
  const ownStart = Object.getOwnPropertyDescriptor(terminal, "start");
  const ownStop = Object.getOwnPropertyDescriptor(terminal, "stop");
  const wrappedStart: typeof start = (...args) => {
    start.apply(terminal, args);
    if (!disposed) {
      running = true;
      shape = undefined;
    }
  };
  const wrappedStop = () => {
    // Fullscreen renders the transcript AFTER stopping. It must not reclaim
    // the cursor then. This also covers external editors, suspend, and crashes.
    if (!disposed) {
      running = false;
      reset();
    }
    stop.call(terminal);
  };
  terminal.start = wrappedStart;
  terminal.stop = wrappedStop;

  return {
    render(mode, lines) {
      if (disposed || !running) return;
      if (
        !get() ||
        !tui.getShowHardwareCursor() ||
        !lines.some((line) => line.includes(CURSOR_MARKER))
      ) {
        reset();
        return;
      }
      const next = shapes[mode];
      if (next !== shape) {
        terminal.write(`\x1b[${next} q`);
        shape = next;
      }
    },
    dispose() {
      if (disposed) return;
      reset();
      disposed = true;
      // Don't remove a later extension's wrapper. Our captured wrappers become
      // inert after disposal if another extension still delegates to them.
      if (terminal.start === wrappedStart) restore(terminal, "start", ownStart);
      if (terminal.stop === wrappedStop) restore(terminal, "stop", ownStop);
      const current = Object.getOwnPropertyDescriptor(editor, "focused");
      if (current?.get === get && current.set === set)
        Object.defineProperty(
          editor,
          "focused",
          "value" in focus ? { ...focus, value: focused } : focus,
        );
    },
  };
}

function restore(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}
