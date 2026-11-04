import {
  CustomEditor,
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { attach, type Position, type Shared } from "./attach.js";

import { createClipboard, readCommands } from "./clipboard.js";
import {
  type Cursor,
  type CursorShapes,
  cursorFor,
  cursorShapes,
} from "./cursor.js";
import { textWidth } from "./reflow.js";

export type {
  VimEditorCapability,
  VimEditorMode,
  VimEditorStatus,
} from "./status.js";

type Factory = NonNullable<
  ReturnType<ExtensionUIContext["getEditorComponent"]>
>;

const OURS = Symbol.for("pi-vim-editor.factory");
const POSITIONS: readonly Position[] = [
  "bottom-right",
  "bottom-left",
  "top-right",
  "top-left",
  "none",
];

/** `vimEditor.indicator` from Pi's settings, or the default. */
function position(settings: unknown): Position {
  const value = (settings as { vimEditor?: { indicator?: unknown } })?.vimEditor
    ?.indicator;
  return POSITIONS.find((p) => p === value) ?? "bottom-right";
}

/**
 * Vim-style modal editing for Pi's prompt editor.
 *
 * Decorates the editor produced by the active factory instead of replacing
 * it. See docs/design.md.
 */
export default function (pi: ExtensionAPI): void {
  let shapes: CursorShapes | undefined;
  const cursors = new WeakMap<object, Cursor>();
  let disposeCursor = () => {};
  let configureCursor = (_shapes: CursorShapes | undefined) => {};
  const shared: Shared = {
    register: undefined,
    notify: () => {},
    clipboard: createClipboard({
      copy: copyToClipboard,
      native: getNativeClipboard,
      commands: () => readCommands(),
    }),
    paint: (_insert, text) => text,
    quit: () => {},
    position: "bottom-right",
  };
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const { ui } = ctx;
    shared.notify = (message, type) => ui.notify(message, type);
    shared.quit = () => ctx.shutdown();
    const settings = pi.getSettings?.();
    shared.position = position(settings);
    shared.textWidth = textWidth(
      (settings as { vimEditor?: { textWidth?: unknown } })?.vimEditor
        ?.textWidth,
    );
    shapes = cursorShapes(
      (settings as { vimEditor?: { cursorShape?: unknown } })?.vimEditor
        ?.cursorShape,
    );
    configureCursor(shapes);
    const clipboard = (settings as { vimEditor?: { clipboard?: unknown } })
      ?.vimEditor?.clipboard;
    shared.unnamed = clipboard === "unnamedplus" || clipboard === "unnamed";
    shared.paint = (insert, text) =>
      ui.theme.fg(insert ? "muted" : "accent", text);
    const previous = ui.getEditorComponent();
    if (previous && OURS in previous) return;
    const factory: Factory = (tui, theme, keybindings) => {
      disposeCursor();
      const editor =
        previous?.(tui, theme, keybindings) ??
        new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      const attached = attach(
        editor,
        keybindings,
        shared,
        (mode, lines) => cursors.get(editor)?.render(mode, lines),
        () => tui.requestRender(),
      );
      disposeCursor = () => {
        cursors.get(editor)?.dispose();
        cursors.delete(editor);
      };
      configureCursor = (next) => {
        disposeCursor();
        if (!next || !attached) return;
        const cursor = cursorFor(editor, tui, next);
        if (cursor) cursors.set(editor, cursor);
        else
          shared.notify(
            "Cursor shapes aren't supported by this editor.",
            "warning",
          );
      };
      configureCursor(shapes);
      return editor;
    };
    ui.setEditorComponent(Object.assign(factory, { [OURS]: true }));
  });
  pi.on("session_shutdown", () => disposeCursor());
}
