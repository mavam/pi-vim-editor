import { CURSOR_MARKER, type TUI } from "@earendil-works/pi-tui";
import type { Mode } from "./engine.js";

// Pi's fake cursor opener right after the focus marker, an APC.
const FAKE_CURSOR = new RegExp(
  `${CURSOR_MARKER.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}\x1b_pi:fc\x07`,
);

export type Cursor = {
  render(mode: Mode, lines: string[]): void;
  dispose(): void;
};

/** Own the cursor shape only while this editor has a visible hardware cursor. */
export function cursorFor(editor: object, tui: TUI): Cursor | undefined {
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
      const next = mode === "insert" ? 6 : mode === "replace" ? 4 : 2;
      if (next !== shape) {
        terminal.write(`\x1b[${next} q`);
        shape = next;
      }
      // Pi draws a fake inverse cursor even with the hardware cursor enabled.
      // Remove only its opening code, keeping the marker, cell, and closing
      // code.
      // Visual highlighting is applied afterward by the editor decorator.
      for (let i = 0; i < lines.length; i++)
        lines[i] = lines[i].replace(FAKE_CURSOR, CURSOR_MARKER);
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
