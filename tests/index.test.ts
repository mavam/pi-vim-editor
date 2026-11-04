import { expect, test } from "bun:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { keybindings, theme, tui } from "./fixtures.ts";

type Factory = (tui: never, theme: never, kb: never) => CustomEditor;

/** Start a session and return the editor factory the extension installed. */
function start(
  mode: string,
  previous?: Factory,
  settings?: unknown,
): Factory | undefined {
  let installed: Factory | undefined;
  let handler: ((event: unknown, ctx: unknown) => void) | undefined;
  extension({
    getSettings: () => settings,
    on: (event: string, h: typeof handler) => {
      if (event === "session_start") handler = h;
    },
  } as never);
  handler?.(
    {},
    {
      mode,
      ui: {
        notify() {},
        theme: { fg: (_color: string, text: string) => text },
        getEditorComponent: () => previous,
        setEditorComponent: (factory: Factory) => {
          installed = factory;
        },
      },
    },
  );
  return installed;
}

const create = (factory: Factory) =>
  factory(tui as never, theme as never, keybindings() as never);
const decorated = (editor: object) => Symbol.for("pi-vim-editor") in editor;

test.each([
  undefined,
  0,
  -1,
  1.5,
  "12",
  null,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  12,
])(
  "loads a positive integer textWidth, otherwise the fixed 79-column default: %j",
  (textWidth) => {
    const editor = create(
      start("tui", undefined, { vimEditor: { textWidth } }) as Factory,
    );
    editor.setText(Array(20).fill("word").join(" "));
    editor.render(20);
    for (const key of ["\x1b", ..."gg0gqq"]) editor.handleInput(key);
    const size = textWidth === 12 ? 2 : 16;
    expect(editor.getText().split("\n")[0]).toBe(
      Array(size).fill("word").join(" "),
    );
  },
);

test("leaves the editor alone outside the TUI", () => {
  expect(start("print")).toBeUndefined();
});

test("decorates Pi's default editor with the inline working status", () => {
  const editor = create(start("tui") as Factory);
  expect(decorated(editor)).toBe(true);
  expect(editor.embedWorkingStatus).toBe(true);
});

test("decorates the editor of a previously installed factory", () => {
  let inner: CustomEditor | undefined;
  const previous: Factory = (t, th, kb) => {
    inner = new CustomEditor(t, th, kb);
    return inner;
  };
  const editor = create(start("tui", previous) as Factory);
  expect(editor).toBe(inner as CustomEditor);
  expect(decorated(editor)).toBe(true);
});

test("accepts none to hide the indicator without disabling Vim", () => {
  const editor = create(
    start("tui", undefined, { vimEditor: { indicator: "none" } }) as Factory,
  );
  const lines = editor.render(40);
  expect([lines[0], lines.at(-1)]).toEqual(Array(2).fill("─".repeat(40)));
  expect(decorated(editor)).toBe(true);
});

test("rereads the indicator setting for an existing editor at session start", () => {
  let indicator = "bottom-right";
  let factory: Factory | undefined;
  let handler: ((event: unknown, ctx: unknown) => void) | undefined;
  extension({
    getSettings: () => ({ vimEditor: { indicator } }),
    on: (event: string, h: typeof handler) => {
      if (event === "session_start") handler = h;
    },
  } as never);
  const session = () =>
    handler?.(
      {},
      {
        mode: "tui",
        ui: {
          notify() {},
          theme: { fg: (_color: string, text: string) => text },
          getEditorComponent: () => factory,
          setEditorComponent: (value: Factory) => {
            factory = value;
          },
        },
      },
    );
  session();
  const installed = factory as Factory;
  const editor = create(installed);
  const raw = "─".repeat(40);
  const left = `─ INSERT ${"─".repeat(31)}`;
  const right = `${"─".repeat(31)} INSERT ─`;
  for (const [position, top, bottom] of [
    ["bottom-right", raw, right],
    ["none", raw, raw],
    ["top-left", left, raw],
    ["top-right", right, raw],
    ["none", raw, raw],
    ["bottom-left", raw, left],
  ]) {
    indicator = position;
    session();
    expect(factory).toBe(installed);
    const lines = editor.render(40);
    expect([lines[0], lines.at(-1)]).toEqual([top, bottom]);
  }
});

test("publishes a fresh status for each new editor", () => {
  const factory = start("tui") as Factory;
  const status = (editor: object) =>
    (editor as Record<symbol, { status(): { mode: string } }>)[
      Symbol.for("pi-vim-editor")
    ].status();
  const first = create(factory);
  first.handleInput("\x1b");
  const second = create(factory);
  expect(status(first).mode).toBe("normal");
  expect(status(second).mode).toBe("insert");
});

test.each([false, true])(
  "cursor shapes are opt-in and cleaned up across their lifecycle (cached editor: %s)",
  (cached) => {
    type Handler = (event: unknown, ctx: unknown) => void;
    const handlers = new Map<string, Handler>();
    let settings: unknown = {};
    let factory: Factory | undefined;
    const writes: string[] = [];
    const host = {
      ...tui,
      terminal: {
        ...tui.terminal,
        write: (text: string) => writes.push(text),
        start() {},
        stop() {},
      },
      getShowHardwareCursor: () => true,
    };
    const originalStart = host.terminal.start;
    const originalStop = host.terminal.stop;
    if (cached) {
      const inner = new CustomEditor(
        host as never,
        theme as never,
        keybindings(),
      );
      factory = () => inner;
    }
    extension({
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      getSettings: () => settings,
    } as never);
    const session = () =>
      handlers.get("session_start")?.(
        {},
        {
          mode: "tui",
          ui: {
            notify() {},
            theme: { fg: (_color: string, text: string) => text },
            getEditorComponent: () => factory,
            setEditorComponent: (value: Factory) => {
              factory = value;
            },
          },
        },
      );
    const editor = () => {
      const result = (factory as Factory)(
        host as never,
        theme as never,
        keybindings() as never,
      );
      result.focused = true;
      result.render(40);
      return result;
    };
    session();
    const first = editor();
    expect(writes).toEqual([]);
    expect(host.terminal.stop).toBe(originalStop);
    settings = { vimEditor: { cursorShape: true } };
    session();
    first.render(40);
    expect(writes).toEqual(["\x1b[6 q"]);
    const second = editor();
    expect(writes).toEqual(["\x1b[6 q", "\x1b[0 q", "\x1b[6 q"]);
    settings = { vimEditor: { cursorShape: false } };
    session();
    second.render(40);
    expect(writes.at(-1)).toBe("\x1b[0 q");
    expect(host.terminal.stop).toBe(originalStop);
    settings = { vimEditor: { cursorShape: true } };
    session();
    second.render(40);
    expect(writes.at(-1)).toBe("\x1b[6 q");
    settings = { vimEditor: { cursorShape: { insert: "blinking-bar" } } };
    session();
    second.render(40);
    expect(writes.slice(-2)).toEqual(["\x1b[0 q", "\x1b[5 q"]);
    handlers.get("session_shutdown")?.({ reason: "reload" }, {});
    expect(writes.slice(-2)).toEqual(["\x1b[5 q", "\x1b[0 q"]);
    const count = writes.length;
    second.render(40);
    first.render(40);
    handlers.get("session_shutdown")?.({ reason: "quit" }, {});
    expect(writes).toHaveLength(count);
    expect(host.terminal.start).toBe(originalStart);
    expect(host.terminal.stop).toBe(originalStop);
  },
);
