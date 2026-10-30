import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { attach, type Shared } from "../src/attach.ts";
import { portFor } from "../src/port.ts";
import type { VimEditorCapability } from "../src/status.ts";
import { keybindings as createKeybindings, theme, tui } from "./fixtures.ts";

/** What the editor publishes for other extensions. */
const capability = (editor: object) =>
  (editor as Record<symbol, VimEditorCapability | undefined>)[
    Symbol.for("pi-vim-editor")
  ];
const status = (editor: object) => capability(editor)?.status();

function setup(
  position: Shared["position"] = "bottom-right",
  Editor: typeof CustomEditor = CustomEditor,
) {
  const notes: string[] = [];
  const copies: string[] = [];
  // What the next clipboard read returns.
  const clipboard: { next: Awaited<ReturnType<Shared["clipboard"]["read"]>> } =
    {
      next: {},
    };
  let quits = 0;
  const shared: Shared = {
    register: undefined,
    notify: (message) => notes.push(message),
    clipboard: {
      write: (register) => copies.push(register.text),
      read: async () => clipboard.next,
    },
    quit: () => {
      quits++;
    },
    position,
    paint: (_insert, text) => `<${text.trim()}>`,
  };
  const keybindings = createKeybindings();
  const editor = new Editor(tui as never, theme as never, keybindings);
  attach(editor, keybindings, shared);
  const type = (...keys: string[]) => {
    for (const key of keys) editor.handleInput(key);
  };
  const quitted = () => quits;
  return {
    editor,
    keybindings,
    shared,
    notes,
    copies,
    clipboard,
    quitted,
    type,
  };
}

test("edits in NORMAL mode, undoes, and labels the border", () => {
  const { editor, type } = setup();
  type(..."foo bar baz", "\x1b", "b", "d", "w");
  expect(editor.getText()).toBe("foo bar ");
  expect(editor.render(40).some((line) => line.includes("<NORMAL>"))).toBe(
    true,
  );
  type("u");
  expect(editor.getText()).toBe("foo bar baz");
});

test("undoes and repeats whole changes, and copies yanks", () => {
  const { editor, copies, type } = setup();
  type(..."foo foo", "\x1b", "0", "i", "z", "\x1b", "u");
  expect(editor.getText()).toBe("foo foo");
  type("c", "w", ..."bar", "\x1b", "w", ".");
  expect(editor.getText()).toBe("bar bar");
  type("u");
  expect(editor.getText()).toBe("bar foo");
  type("u");
  expect(editor.getText()).toBe("foo foo");
  type("y", "y");
  expect(copies).toEqual(["foo foo"]);
});

test("changes a backtick path, repeats it, and undoes each whole change", () => {
  const { editor, type } = setup();
  type(..."`src/old.ts` `other.ts`", "\x1b", "0", "5", "l", "c", "i", "`");
  expect(editor.getText()).toBe("`` `other.ts`");
  expect(status(editor)?.mode).toBe("insert");
  type(..."src/new.ts", "\x1b");
  expect(editor.getText()).toBe("`src/new.ts` `other.ts`");
  expect(status(editor)?.mode).toBe("normal");
  type("$", ".");
  expect(editor.getText()).toBe("`src/new.ts` `src/new.ts`");
  type("u");
  expect(editor.getText()).toBe("`src/new.ts` `other.ts`");
  type("u");
  expect(editor.getText()).toBe("`src/old.ts` `other.ts`");
});

test.each([
  ["yi`", "src/old.ts"],
  ["ya`", "`src/old.ts`"],
  ["vi`y", "src/old.ts"],
  ["va`y", "`src/old.ts`"],
])("copies a backtick object: %s", (keys, text) => {
  const { editor, type, copies, shared } = setup();
  type(..."`src/old.ts`", "\x1b", "0", ...keys);
  expect(editor.getText()).toBe("`src/old.ts`");
  expect(copies).toEqual([text]);
  expect(shared.register).toEqual({ text, linewise: false });
});

test("undoes a sentence change in one step", () => {
  const { editor, type } = setup();
  type(..."One. Two. Three.", "\x1b", "0", "c", "2", ")", ..."New. ", "\x1b");
  expect(editor.getText()).toBe("New. Three.");
  type("u");
  expect(editor.getText()).toBe("One. Two. Three.");
});

test("undoes and repeats a whole inner-sentence change", () => {
  const { editor, type } = setup();
  type(
    ..."One. Two. Three.",
    "\x1b",
    "0",
    "l",
    "c",
    "i",
    "s",
    ..."New.",
    "\x1b",
  );
  expect(editor.getText()).toBe("New. Two. Three.");
  type("w", ".");
  expect(editor.getText()).toBe("New. New. Three.");
  type("u");
  expect(editor.getText()).toBe("New. Two. Three.");
  type("u");
  expect(editor.getText()).toBe("One. Two. Three.");
});

test.each([
  ["One. Two. Three.", "yis", "One.", false],
  ["One. Two. Three.", "yas", "One. ", false],
  ["One. Two. Three.", "y2is", "One. ", false],
  ["One. Two. Three.", "y2as", "One. Two. ", false],
  ["One.\nTwo.", "yis", "One.", true],
  ["One.\nTwo.", "visy", "One.", false],
  ["One.\n  Two.", "vasy", "One.\n  ", false],
  ["One\ncontinues. Next.", "visy", "One\ncontinues.", false],
  ["One\n\nTwo.", "vasasy", "One\n\n", false],
] as const)(
  "copies sentence objects: %j + %j",
  (before, keys, text, linewise) => {
    const { editor, type, copies, shared } = setup();
    editor.setText(before);
    type("\x1b", "g", "g", "0", ...keys);
    expect(editor.getText()).toBe(before);
    expect(copies).toEqual([text]);
    expect(shared.register).toEqual({ text, linewise });
  },
);

test.each([
  ["alpha\nbeta\n\nafter", "yip", "alpha\nbeta", true],
  ["alpha\nbeta\n\nafter", "yap", "alpha\nbeta\n", true],
  ["alpha\n \n    \nafter", "y2ip", "alpha\n \n    ", true],
  ["alpha\n\nbeta\n\ngamma", "y3ip", "alpha\n\nbeta", true],
  ["", "yip", "", true],
  ["AA\naaa\n\nBB\nbbb\n\nCC", "vipy", "AA\naaa", true],
  ["AA\naaa\n\nBB\nbbb\n\nCC", "vapy", "AA\naaa\n", true],
  ["AA\naaa\n\nBB\nbbb\n\nCC", "vipipy", "AA\naaa\n", true],
  ["AA\naaa\n\nBB\nbbb\n\nCC", "vipapy", "AA\naaa\n\nBB\nbbb", true],
  ["AA\naaa\n\nBB\nbbb\n\nCC", "3jvipoipy", "\nBB\nbbb", true],
  ["AA\naaa\n\nBB\nbbb\n\nCC", "3jvipoapy", "AA\naaa\n\nBB\nbbb", true],
  ["AA\naaa\n\nBB\nbbb\n\nCC", "vjipy", "AA\naaa\n\n", false],
  ["abcd\nefgh\nijkl\n\nmnop", "2lvjipy", "cd\nefgh\ni", false],
  ["abcd\nefgh\nijkl\n\nmnop", "2lVjipy", "abcd\nefgh\nijkl", true],
  ["abcd\nefgh\nijkl\n\nmnop", "jVipy", "abcd\nefgh\nijkl", true],
  ["abcd\nefgh\nijkl\n\nmnop", "2jVipy", "abcd\nefgh\nijkl", true],
  ["A\n\nBB\nbb\n\nCC\ncc", "2jV2apy", "\nBB\nbb\n\nCC\ncc", true],
  ["A\n\nBB\nbb\n\nCC\ncc", "2jvip2apy", "BB\nbb\n\nCC\ncc", true],
  ["A\n\nBB\nbb\n\nCC\ncc", "2jvap2ipy", "BB\nbb\n\nCC\ncc", true],
  ["A\n\nBB\nbb\n\nCC\ncc", "2jvipo2apy", "A\n\nBB\nbb", true],
  ["abcd\nefgh\n\nmnop", "lvipvy", "bcd\ne", false],
  ["A\n\nB", "V3ipy", "A\n\nB", true],
  ["A\n\nB", "V4ipy", "A", true],
  ["A\n\nB", "V2apy", "A\n\nB", true],
  ["A\n\nB", "V3apy", "A", true],
  ["A\n\nB", "GVapy", "\nB", true],
  ["AA\n\nBB\n\nCC", "2jV2apy", "\nBB\n\nCC", true],
  ["AA\naaa\n\nBB\nbbb\n\nCC", "3jvkipy", "AA\naaa\n\nB", false],
  ["AA\naaa\n\nBB", "\x16ipy", "AA\naaa", true],
] as const)(
  "copies paragraph objects with their selection shape: %j + %j",
  (before, keys, text, linewise) => {
    const { editor, type, copies, shared } = setup();
    editor.setText(before);
    type("\x1b", "g", "g", "0", ...keys);
    expect(editor.getText()).toBe(before);
    expect(copies).toEqual([text]);
    expect(shared.register).toEqual({ text, linewise });
  },
);

test.each([
  ["one\ntwo\n\nthree", "y}", "one\ntwo", true],
  ["one\ntwo\n\nthree", "ly}", "ne\ntwo", false],
  ["one\ntwo", "y}", "one\ntwo", false],
  ["one\n\ntwo", "Gy{", "", true],
  ["one\n\ntwo", "v}y", "one\n\n", false],
  ["one\n\ntwo", "V}y", "one\n", true],
  ["one\n\ntwo", "Gv{y", "\nt", false],
] as const)(
  "copies paragraph motions with their selection shape: %j + %j",
  (before, keys, text, linewise) => {
    const { editor, type, copies, shared } = setup();
    editor.setText(before);
    type("\x1b", "g", "g", "0", ...keys);
    expect(editor.getText()).toBe(before);
    expect(copies).toEqual([text]);
    expect(shared.register).toEqual({ text, linewise });
  },
);

test("repeats a paragraph motion change and undoes each whole change", () => {
  const { editor, type } = setup();
  const before = "First\ninstruction\n\nSecond\ninstruction\n\nLast";
  editor.setText(before);
  type("\x1b", "g", "g", "c", "}", ..."New", "\x1b");
  expect(editor.getText()).toBe("New\n\nSecond\ninstruction\n\nLast");
  type("2", "j", "0", ".");
  expect(editor.getText()).toBe("New\n\nNew\n\nLast");
  type("u");
  expect(editor.getText()).toBe("New\n\nSecond\ninstruction\n\nLast");
  type("u");
  expect(editor.getText()).toBe(before);
});

test("a repeat count replaces a paragraph motion count", () => {
  const { editor, type } = setup();
  const before = "A\n\nB\n\nC\n\nD\n\nE";
  editor.setText(before);
  type("\x1b", "g", "g", "d", "}", "j", "2", ".");
  expect(editor.getText()).toBe("\n\nD\n\nE");
  type("u");
  expect(editor.getText()).toBe("\nB\n\nC\n\nD\n\nE");
  type("u");
  expect(editor.getText()).toBe(before);
});

test.each(["y3}", "d3}", "c3}", "gu3}", "gU3}"])(
  "paragraph motion overruns preserve text, register, and mode: %s",
  (keys) => {
    const { editor, type, shared } = setup();
    const before = "A\n\nB";
    editor.setText(before);
    type("\x1b", "g", "g", "y", "y", ...keys);
    expect(editor.getText()).toBe(before);
    expect(shared.register).toEqual({ text: "A", linewise: true });
    expect(status(editor)?.mode).toBe("normal");
    expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
  },
);

test.each(["y{", "Gy}"])(
  "empty paragraph motion yanks preserve the previous register: %s",
  (keys) => {
    const { editor, type, shared } = setup();
    editor.setText("one\n");
    type("\x1b", "g", "g", "y", "y", ...keys);
    expect(shared.register).toEqual({ text: "one", linewise: true });
  },
);

test("paragraph motions keep pasted blocks opaque and refuse edits across them", () => {
  const { editor, type, shared, notes } = setup();
  const payload = "inside\n\n".repeat(6);
  editor.setText("before\n\n\nafter");
  type("\x1b", "g", "g", "j", "i", `\x1b[200~${payload}\x1b[201~`);
  const before = editor.getText();
  type("\x1b", "g", "g", "y", "y", "}");
  expect(editor.getCursor()).toEqual({ line: 2, col: 0 });
  type("g", "g", "d", "}");
  expect(editor.getText()).toBe(before);
  expect(shared.register).toEqual({ text: "before", linewise: true });
  expect(notes).toHaveLength(1);
});

test("undoes and repeats a whole paragraph change", () => {
  const { editor, type, shared } = setup();
  const before = "  First\n  instruction\n\nSecond\ninstruction\n\nLast";
  editor.setText(before);
  type("\x1b", "g", "g", "c", "i", "p", ..."New", "\x1b");
  expect(editor.getText()).toBe("New\n\nSecond\ninstruction\n\nLast");
  expect(shared.register).toEqual({
    text: "  First\n  instruction",
    linewise: true,
  });
  type("2", "j", ".");
  expect(editor.getText()).toBe("New\n\nNew\n\nLast");
  type("u");
  expect(editor.getText()).toBe("New\n\nSecond\ninstruction\n\nLast");
  type("u");
  expect(editor.getText()).toBe(before);
});

test("repeats a Visual paragraph delete by its linewise extent", () => {
  const { editor, type } = setup();
  editor.setText("A\na\n\nB\nb\n\nC");
  type("\x1b", "g", "g", "v", "a", "p");
  expect(status(editor)?.mode).toBe("visual-line");
  expect(editor.render(40).some((line) => line.includes("<VISUAL LINE>"))).toBe(
    true,
  );
  type("d", ".");
  expect(editor.getText()).toBe("C");
  type("u");
  expect(editor.getText()).toBe("B\nb\n\nC");
  type("u");
  expect(editor.getText()).toBe("A\na\n\nB\nb\n\nC");
});

test.each(["y2ip", "y2ap", "d2ip", "c2ap"])(
  "paragraph count overruns leave the buffer and register unchanged: %s",
  (keys) => {
    const { editor, type, shared } = setup();
    editor.setText("A\n\nB");
    type("\x1b", "g", "g", "y", "i", "p", "G", ...keys);
    expect(editor.getText()).toBe("A\n\nB");
    expect(shared.register).toEqual({ text: "A", linewise: true });
    expect(status(editor)?.mode).toBe("normal");
  },
);

test("a failed Visual paragraph extension preserves the selection", () => {
  const { editor, type, shared } = setup();
  editor.setText("A\n\nB\nb");
  type("\x1b", "G", "v", "i", "p", "i", "p");
  expect(status(editor)?.mode).toBe("visual-line");
  type("y");
  expect(shared.register).toEqual({ text: "B\nb", linewise: true });
});

test("highlights the Visual selection", () => {
  const { editor, type } = setup();
  type(..."foo bar", "\x1b", "0", "v", "e");
  const lines = editor.render(40);
  expect(lines[1]).toStartWith("\x1b[7mfo");
  expect(lines[1]).toContain("\x1b[27m bar");
  expect(lines.some((line) => line.includes("<VISUAL>"))).toBe(true);
});

test("inserts and appends on every line of a block", () => {
  const { editor, type } = setup();
  editor.setText("ab\ncd");
  type("\x1b", "g", "g", "0", "\x16", "j", "I", "-", " ", "\x1b");
  expect(editor.getText()).toBe("- ab\n- cd");
  type("$", "\x16", "j", "A", "!", "\x1b");
  expect(editor.getText()).toBe("- ab!\n- cd!");
  type("u");
  expect(editor.getText()).toBe("- ab\n- cd");
});

test("quits with :q only when the prompt is empty, or with :q!", () => {
  const { quitted, notes, type } = setup();
  type("a", "\x1b", ":", "q", "\r");
  expect([quitted(), notes.length]).toEqual([0, 1]);
  type(":", "q", "!", "\r");
  expect(quitted()).toBe(1);
});

test("puts the mode label where the setting says", () => {
  const { editor } = setup("top-left");
  expect(editor.render(40)[0]).toStartWith("─<INSERT>─");
});

test("ends Visual mode when something else changes the text", () => {
  const { editor, type } = setup();
  editor.setText("a\nb\nc");
  type("\x1b", "V");
  editor.setText("x");
  expect(status(editor)?.mode).toBe("normal");
  expect(editor.render(40).some((line) => line.includes("<NORMAL>"))).toBe(
    true,
  );
});

test("doesn't copy pasted blocks to the other lines of a block", () => {
  const { editor, notes, type } = setup();
  editor.setText("ab\ncd");
  const paste = `\x1b[200~${"x\n".repeat(12)}\x1b[201~`;
  type("\x1b", "g", "g", "0", "\x16", "j", "I", paste, "\x1b");
  expect(editor.getText()).toBe("[paste #1 +13 lines]ab\ncd");
  expect(notes).toHaveLength(1);
});

test("overwrites in Replace mode, with Backspace, ., and one undo", () => {
  const { editor, type } = setup();
  editor.setText("abcd efgh");
  type("\x1b", "0", "R", "x", "y", "z", "\x7f", "\x1b");
  expect(editor.getText()).toBe("xycd efgh");
  type("w", ".");
  expect(editor.getText()).toBe("xycd xygh");
  type("u");
  expect(editor.getText()).toBe("xycd efgh");
  type("u");
  expect(editor.getText()).toBe("abcd efgh");
});

test("doesn't restore in Replace mode after a paste moved things", () => {
  const { editor, type } = setup();
  editor.setText("abcd efgh");
  type("\x1b", "0", "R", "x", "\x1b[200~QQ\x1b[201~", "\x7f");
  expect(editor.getText()).toBe("xQQbcd efgh");
});

test("redoes with Ctrl-R until another edit", () => {
  const { editor, notes, type } = setup();
  editor.setText("one two");
  type("\x1b", "0", "d", "w", "x", "u", "u");
  expect(editor.getText()).toBe("one two");
  type("w", "\x12");
  expect(editor.getText()).toBe("two");
  type("\x12");
  expect(editor.getText()).toBe("wo");
  type("u", "x", "\x12");
  expect([editor.getText(), notes]).toEqual(["wo", ["Nothing to redo."]]);
});

test("puts the cursor at the redone change, and forgets it after typing", () => {
  const { editor, type } = setup();
  editor.setText("abcdef");
  type("\x1b", "0", "x", "$", "u", "\x12");
  expect([editor.getText(), editor.getCursor().col]).toEqual(["bcdef", 0]);
  type("u", "i", "Z", "\x7f", "\x1b", "\x12");
  expect(editor.getText()).toBe("abcdef");
});

test('puts the system clipboard with "+p unless the prompt changed', async () => {
  const { editor, copies, clipboard, notes, type } = setup();
  editor.focused = true;
  editor.setText("one");
  type("\x1b", '"', "+", "d", "d");
  expect(copies).toEqual(["one"]);
  clipboard.next = { register: { text: "two", linewise: true } };
  type('"', "+", "2", "p");
  await Bun.sleep(0);
  expect(editor.getText()).toBe("\ntwo\ntwo");
  type(".");
  await Bun.sleep(0);
  expect(editor.getText()).toBe("\ntwo\ntwo\ntwo\ntwo");
  editor.setText("abc");
  type("0", '"', "+", "p", "x");
  await Bun.sleep(0);
  expect([editor.getText(), notes.at(-1)]).toEqual([
    "bc",
    "The prompt changed; not putting the clipboard.",
  ]);
});

test("uses the system clipboard for p and every copy when unnamed", async () => {
  const { editor, shared, copies, clipboard, notes, type } = setup();
  shared.unnamed = true;
  editor.focused = true;
  editor.setText("ab");
  type("\x1b", "0", "x");
  expect(copies).toEqual(["a"]);
  clipboard.next = { register: { text: "Z", linewise: false } };
  type("p", ".");
  await Bun.sleep(0);
  expect(editor.getText()).toBe("bZZ");
  // If reading fails, p puts our last copy without a warning.
  clipboard.next = {
    register: { text: "a", linewise: false },
    warning: "Couldn't read the clipboard; using the last copy.",
  };
  type("P");
  await Bun.sleep(0);
  expect([editor.getText(), notes]).toEqual(["bZaZ", []]);
});

test("runs queued clipboard puts in order, and drops stale ones", async () => {
  const { editor, shared, type } = setup();
  editor.focused = true;
  editor.setText("abc");
  // Reads answer one after another, each when its key is released.
  const reads: ((text: string) => void)[] = [];
  shared.clipboard.read = () =>
    new Promise((resolve) =>
      reads.push((text) => resolve({ register: { text, linewise: false } })),
    );
  const answer = async (text: string) => {
    await Bun.sleep(0);
    reads.shift()?.(text);
    await Bun.sleep(0);
  };
  type("\x1b", "0", '"', "+", "p", '"', "+", "p");
  await answer("1");
  await answer("2");
  expect(editor.getText()).toBe("a12bc");
  // Moving away and back still makes a pending put stale.
  type('"', "+", "p", "l", "h");
  await answer("3");
  expect(editor.getText()).toBe("a12bc");
});

// `.` cases checked against Neovim; `|` is the cursor in the initial text.
const keyCodes: Record<string, string> = {
  "<Esc>": "\x1b",
  "<BS>": "\x7f",
  "<Del>": "\x1b[3~",
  "<Left>": "\x1b[D",
  "<C-v>": "\x16",
  "<C-j>": "\n",
};
test.each([
  ["|aaa 😀😀😀", "i<Del>X<Esc>w.", "Xaa X😀😀"],
  ["|abcdef\nabcdef\nabcdef\nx", "ll<C-v>j$d3G02l.", "ab\nab\nab\nx"],
  ["|abcdef\nabcdef\n中def\n中def", "<C-v>jld3G0.", "cdef\ncdef\ndef\ndef"],
  ["aa|aa bbbb cccc", "i<BS><Esc>w.", "aaabbbb cccc"],
  ["|a b c d e f g h", "dw2..", "f g h"],
  ["|A. B. C. D. E.", "d)2.", "D. E."],
  ["|A. B. C. D. E. F. G.", "2d3is2.", "E. F. G."],
  ["|A. B. C. D. E.", "d2as2.", "E."],
  ["|A. B. C. D. E. F. G.", "2das.", "E. F. G."],
  ["|A\n\nB\n\nC\n\nD\n\nE", "2dap1.", "D\n\nE"],
  ["|One\nmore.\nTwo\nmore.\nThree.", "visdj0.", "\n\nThree."],
  ["|abcd xyz", "i<Del>X<Esc>w2.", "Xbcd XXz"],
  ["|one\ntwo\nthree\nfour\nfive", "Sx<Esc>j2.", "x\nx\nfour\nfive"],
  ["|abc def ghi", "vlcX<Esc>w2.", "Xc Xf ghi"],
  ["|abc def ghi", "iX<Left><Esc>w.", "Xabc Xdef ghi"],
  ["|x", "Oa<C-j>b<Esc>G2.", "a\nb\na\nb\na\nb\nx"],
  ["|aa\n中xyz\nqq\nabcdef", "vjlU2j0.", "AA\n中Xyz\nQQ\nABCdef"],
  ["|[paste #9] abcdef", "v9ldw.", " "],
  ["|a,b,c,d,e", "f,lvUl.;x", "a,B,cd,e"],
  ["|a\nb\nc\nd", "<C-v>jI- <Esc>jj0.", "- a\n- b\n- c\n- d"],
])("repeats with .: %j + %j", (before, keys, after) => {
  const { editor, type } = setup();
  const lines = before.split("\n");
  const line = lines.findIndex((l) => l.includes("|"));
  editor.setText(before.replace("|", ""));
  type("\x1b", "g", "g", "0", ...Array(line).fill("j"));
  type(...Array(lines[line].indexOf("|")).fill("l"));
  type(...(keys.match(/<[^>]+>|./gsu) ?? []).map((k) => keyCodes[k] ?? k));
  expect(editor.getText()).toBe(after);
});

test("repeats INSERT edits with their pasted blocks and counts", () => {
  const { editor, type } = setup();
  editor.setText("a b");
  const paste = `\x1b[200~${"x\n".repeat(12)}\x1b[201~`;
  type("\x1b", "0", "i", paste, "\x1b", "w", "w", "2", ".");
  expect(editor.getExpandedText()).toBe(
    `${"x\n".repeat(12)}a ${"x\n".repeat(24)}b`,
  );
  // Repeats paste the block again as new pasted blocks, not live markers.
  expect(editor.getText()).toBe(
    "[paste #1 +13 lines]a [paste #2 +13 lines][paste #3 +13 lines]b",
  );
});

test("hands Esc and Enter in NORMAL mode to Pi", () => {
  const { editor, type } = setup();
  let interrupted = false;
  editor.onEscape = () => {
    interrupted = true;
  };
  editor.onSubmit = () => {};
  type("a", "\x1b", "\x1b");
  expect(interrupted).toBe(true);
  type("\r", "x");
  expect(editor.getText()).toBe("x");
});

test("fails closed on editors without the expected internals", () => {
  const { keybindings, shared, notes } = setup();
  const editor = { handleInput() {}, renderBottomBorder: () => "" };
  expect(attach(editor, keybindings, shared)).toBe(false);
  expect(notes).toHaveLength(1);
  expect(capability(editor)).toBeUndefined();
});

// Editors that rearrange Pi's rows after rendering them, as framing
// extensions do: the rows no longer match Pi's layout.
class Railed extends CustomEditor {
  override render(width: number) {
    return super
      .render(width - 2)
      .slice(1, -1)
      .map((row) => `| ${row}`);
  }
}
class Framed extends CustomEditor {
  override render(width: number) {
    return super.render(width - 2).map((row) => `| ${row}`);
  }
}
class Headless extends CustomEditor {
  override render(width: number) {
    return super.render(width).slice(1);
  }
}

test.each([
  ["drops the borders", Railed],
  ["renders narrower and indents", Framed],
  ["drops the top border", Headless],
])("doesn't highlight in the wrong place when an editor %s", (_, Editor) => {
  const { editor, type } = setup("bottom-right", Editor);
  editor.setText("first\nsecond\nthird");
  type("\x1b", "G", "V");
  const lines = editor.render(40);
  expect(lines.join("\n")).not.toContain("\x1b[27m");
  expect(lines.some((line) => line.includes("hird"))).toBe(true);
  expect(status(editor)?.label).toBe("VISUAL LINE");
  type("d");
  expect(editor.getText()).toBe("first\nsecond");
});

test("publishes the current mode and pending keys", () => {
  const { editor, type } = setup();
  editor.setText("foo bar");
  const steps: [string[], string, string, string][] = [
    [[], "insert", "", "INSERT"],
    [["\x1b"], "normal", "", "NORMAL"],
    [["2", "d"], "normal", "2d", "2d"],
    [["\x1b", '"', "+"], "normal", '"+', '"+'],
    [["\x1b", "v"], "visual", "", "VISUAL"],
    [["V"], "visual-line", "", "VISUAL LINE"],
    [["\x16"], "visual-block", "", "VISUAL BLOCK"],
    [["\x1b", "R"], "replace", "", "REPLACE"],
    [["\x1b", ":", "q"], "normal", ":q", ":q"],
  ];
  for (const [keys, mode, pending, label] of steps) {
    type(...keys);
    // Current without a render in between, and the same as the border.
    expect(status(editor)).toEqual({ mode, pending, label } as never);
    expect(editor.render(40).at(-1)).toContain(`<${label}>`);
  }
});

test("gwap tracks the cursor's text, preserves the register, and repeats with one-step undo", () => {
  const { editor, shared, copies, type } = setup();
  shared.textWidth = 12;
  const register = { text: "keep me", linewise: false };
  shared.register = register;
  const paragraph = "one two three four five six";
  editor.setText(`${paragraph}\n\n${paragraph}`);
  type("\x1b", ..."gg019lgwap");
  expect(editor.getText()).toBe(
    `one two\nthree four\nfive six\n\n${paragraph}`,
  );
  expect(editor.getCursor()).toEqual({ line: 2, col: 0 });
  type(..."G0.");
  expect(editor.getText()).toBe(
    "one two\nthree four\nfive six\n\none two\nthree four\nfive six",
  );
  type("u");
  expect(editor.getText()).toBe(
    `one two\nthree four\nfive six\n\n${paragraph}`,
  );
  type("u");
  expect(editor.getText()).toBe(`${paragraph}\n\n${paragraph}`);
  expect(shared.register).toBe(register);
  expect(copies).toEqual([]);
});

test.each(["gqap", "vapgq"])(
  "%s formats once and lands on the retained separator",
  (keys) => {
    const { editor, shared, type } = setup();
    shared.textWidth = 12;
    const before = "one two three four five six\n\nnext";
    editor.setText(before);
    type("\x1b", ..."gg0", ...keys);
    expect(editor.getText()).toBe("one two\nthree four\nfive six\n\nnext");
    expect(editor.getCursor()).toEqual({ line: 3, col: 0 });
    type("u");
    expect(editor.getText()).toBe(before);
  },
);

test("unchanged and refused formatting never writes, copies, or consumes undo", () => {
  const { editor, shared, notes, copies, type } = setup();
  shared.textWidth = 12;
  editor.setText("short");
  type("\x1b", ..."gg0x");
  let changes = 0;
  editor.onChange = () => changes++;
  type(..."gwap");
  expect(changes).toBe(0);
  type("u");
  expect(editor.getText()).toBe("short");
  editor.setText("one two three four\n\nend");
  type(..."G$", `\x1b[200~${"paste\n".repeat(12)}\x1b[201~`);
  const before = editor.getText();
  changes = 0;
  const register = shared.register;
  type(..."gg0gqG");
  expect(editor.getText()).toBe(before);
  expect(changes).toBe(0);
  expect(shared.register).toBe(register);
  expect(copies).toEqual([]);
  expect(notes.at(-1)).toBe("Vim edits can't touch pasted blocks.");
});

test.each([
  ["/", false],
  ["?", false],
  ["/", true],
  ["?", true],
] as const)(
  "%sfoo stays active with render and status between every key (Visual: %s)",
  (direction, visual) => {
    const { editor, type, copies } = setup();
    const prompt = "foo x foo";
    editor.setText(prompt);
    let submits = 0;
    let interrupts = 0;
    editor.onSubmit = () => submits++;
    editor.onEscape = () => interrupts++;
    const frame = () => {
      const before = status(editor);
      editor.render(40);
      expect(status(editor)).toEqual(before);
      expect(editor.getText()).toBe(prompt);
      expect(submits).toBe(0);
      expect(interrupts).toBe(0);
      return before;
    };
    const key = (input: string) => {
      type(input);
      return frame();
    };
    for (const input of ["\x1b", "0", ...(visual ? ["v"] : [])]) key(input);
    const mode = visual ? "visual" : "normal";
    // First cancel a fully typed query, then confirm one. No batched input.
    for (const finish of ["\x1b", "\r"]) {
      let pending = "";
      for (const input of `${direction}foo`) {
        pending += input;
        expect(key(input)).toEqual({ mode, pending, label: pending });
        expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
      }
      expect(key(finish)?.mode).toBe(mode);
      expect(status(editor)?.pending).toBe("");
      expect(editor.getCursor()).toEqual({
        line: 0,
        col: finish === "\x1b" ? 0 : 6,
      });
    }
    if (visual) {
      key("y");
      expect(copies).toEqual(["foo x f"]);
    }
  },
);

test("search owns Enter, Esc, Ctrl-[, Backspace, and modified shortcuts", () => {
  const { editor, type } = setup();
  editor.setText("a foo foo");
  let submissions = 0;
  let interrupts = 0;
  let changes = 0;
  editor.onSubmit = () => submissions++;
  editor.onEscape = () => interrupts++;
  type("\x1b", "0", "/foo");
  editor.onChange = () => changes++;
  expect(status(editor)?.pending).toBe("/foo");
  expect(editor.render(40).at(-1)).toContain("</foo>");
  type("é", "\x7f");
  expect(status(editor)?.pending).toBe("/foo");
  // All these would normally navigate, edit, or invoke Pi actions.
  type(
    "\x03",
    "\x07",
    "\x15",
    "\x16",
    "\x12",
    "\x1b[D",
    "\t",
    "\x1bx",
    "\x1b[13;2u",
  );
  expect(status(editor)?.pending).toBe("/foo");
  type("\r");
  expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
  for (const cancel of ["\x1b", "\x1b[91;5u"]) {
    type("/foo", cancel);
    expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
    expect(status(editor)?.pending).toBe("");
  }
  expect(editor.getText()).toBe("a foo foo");
  expect([submissions, interrupts, changes]).toEqual([0, 0, 0]);
  type("\r");
  expect(submissions).toBe(1);
});

test("query paste searches across lines and escapes terminal controls in status", () => {
  const { editor, type } = setup();
  editor.setText("a\nfoo\nbar");
  type("\x1b", "g", "g", "/", "\x1b[200~foo\r\nbar\x1b[201~");
  expect(status(editor)?.label).toBe("/foo\\nbar");
  expect(editor.getText()).toBe("a\nfoo\nbar");
  type("\r");
  expect(editor.getCursor()).toEqual({ line: 1, col: 0 });
  type("/", "\x1b[200~\x1b]0;unsafe\x07\u009b\u202e\x1b[201~");
  const pending = status(editor)?.pending ?? "";
  expect(pending).toContain("\\u001b");
  expect(pending).toContain("\\u009b");
  expect(pending).toContain("\\u202e");
  expect(editor.render(100).join("\n")).not.toContain("\x1b]0;unsafe");
  type("\x1b", "/", "\x1b[200~fo", "o", "\x1b[201~", "\r");
  expect(editor.getCursor()).toEqual({ line: 1, col: 0 });
  expect(editor.getText()).toBe("a\nfoo\nbar");
});

test("search skips both paste markers and their hidden contents", () => {
  const { editor, type, notes } = setup();
  type(
    "a ",
    `\x1b[200~${"secret\n".repeat(12)}\x1b[201~`,
    " visible",
    "\x1b",
    "0",
  );
  const text = editor.getText();
  for (const query of ["paste", "secret", "[paste #1 +13 lines]"]) {
    type("/", query, "\r");
    expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
    expect(notes.at(-1)).toBe("Search: no match in the prompt.");
  }
  expect(editor.getText()).toBe(text);
  type("/visible", "\r");
  expect(editor.getCursor().col).toBe(text.indexOf("visible"));
});

test.each([false, true])(
  "external changes cancel queries safely, including after render: %s",
  (renderFirst) => {
    const { editor, type } = setup();
    editor.setText("a foo");
    let submits = 0;
    let interrupts = 0;
    editor.onSubmit = () => submits++;
    editor.onEscape = () => interrupts++;
    type("\x1b", "0", "v", "/foo");
    editor.setText("new prompt");
    if (renderFirst) editor.render(40);
    type("\r");
    expect(editor.getText()).toBe("new prompt");
    expect(status(editor)?.mode).toBe("normal");
    type("/foo");
    // Real host cursor mutation, without passing through our input wrapper.
    editor.insertTextAtCursor("!");
    if (renderFirst) status(editor);
    type("\x1b");
    expect([submits, interrupts]).toEqual([0, 0]);
    expect(status(editor)?.pending).toBe("");
  },
);

test("external cursor changes preserve Visual anchors and cancelled split pastes never leak", () => {
  const { editor, type } = setup();
  editor.setText("a foo foo");
  type("\x1b", "0", "v", "/foo");
  const port = portFor(editor);
  port?.setCursor({ line: 0, col: 2 });
  type("\r");
  expect(status(editor)?.mode).toBe("visual");
  type("y");
  expect(editor.getText()).toBe("a foo foo");
  type("/", "\x1b[200~fo");
  editor.setText("changed");
  let submits = 0;
  editor.onSubmit = () => submits++;
  type("o", "\x1b[201~", "\r");
  expect(submits).toBe(0);
  expect(editor.getText()).toBe("changed");
  expect(status(editor)?.pending).toBe("");
});

test("Visual search extends or cancels the selection without losing its anchor", () => {
  const { editor, type, copies } = setup();
  editor.setText("a foo foo");
  type("\x1b", "0", "v", "/missing", "\x1b", "/foo", "\r", "n", "y");
  expect(copies).toEqual(["a foo f"]);
  expect(editor.getText()).toBe("a foo foo");
});

test("search preserves undo, dot, registers, redo, and direction across other commands", () => {
  const { editor, type, shared } = setup();
  editor.setText("a foo foo");
  type("\x1b", "0", "x");
  const register = shared.register;
  type("/foo", "\r", ":x", "\r", "n");
  expect(editor.getCursor()).toEqual({ line: 0, col: 5 });
  expect(shared.register).toBe(register);
  type(".");
  expect(editor.getText()).toBe(" foo oo");
  type("u", "u");
  expect(editor.getText()).toBe("a foo foo");
  type("/foo", "\r", "\x12");
  expect(editor.getText()).toBe(" foo foo");
});

test("search history resets after submit and is private to each editor", () => {
  const { editor, type, notes } = setup();
  editor.setText("a foo");
  editor.onSubmit = () => {};
  type("\x1b", "0", "/foo", "\r", "\r", "next", "\x1b", "n");
  expect(notes.at(-1)).toBe("No previous search.");
  const other = setup();
  other.type("a", "\x1b", "/", "\r");
  expect(other.notes.at(-1)).toBe("No previous search.");
});

test("keeps one status per editor, back in INSERT after a submit", () => {
  const { editor, keybindings, shared, type } = setup();
  const published = capability(editor);
  expect(published?.version).toBe(1);
  expect(attach(editor, keybindings, shared)).toBe(true);
  expect(capability(editor)).toBe(published);
  editor.onSubmit = () => {};
  type("a", "\x1b");
  expect(status(editor)?.mode).toBe("normal");
  type("\r");
  expect(status(editor)?.mode).toBe("insert");
});

const tenLines = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");

test("moves by the rows Pi wraps the prompt into", () => {
  const { editor, type } = setup();
  const text = "one two three four five six seven eight nine ten";
  editor.setText(text);
  editor.render(20);
  type("\x1b", "0", "g", "j");
  expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("five") });
  type("g", "$");
  expect(editor.getCursor()).toEqual({
    line: 0,
    col: text.indexOf("eight") - 1,
  });
  type("g", "k", "g", "0");
  expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
});

// A 24-row terminal shows seven rows.
test("H, M, and L see what Pi's next render shows", () => {
  const { editor, type } = setup();
  editor.render(40);
  // The text grew since the last render, which showed one row.
  editor.setText(tenLines);
  type("\x1b", "H");
  expect(editor.getCursor()).toEqual({ line: 3, col: 0 });
  type("L");
  expect(editor.getCursor()).toEqual({ line: 9, col: 0 });
  type("g", "g");
  editor.render(40);
  // Several motions before a render agree on the scrolled view.
  type("G", "H", "M");
  expect(editor.getCursor()).toEqual({ line: 6, col: 0 });
  expect(
    editor
      .render(40)
      .slice(1, -1)
      .map((row) => stripVTControlCharacters(row).trim()),
  ).toEqual(["l3", "l4", "l5", "l6", "l7", "l8", "l9"]);
});

// Shows only the last three of Pi's rows, between its borders.
class Clipped extends CustomEditor {
  override render(width: number) {
    const rows = super.render(width);
    return [rows[0], ...rows.slice(-4, -1), rows[rows.length - 1]];
  }
}

test("H does nothing when an editor rearranges Pi's rows", () => {
  const { editor, type } = setup("bottom-right", Clipped);
  editor.setText(tenLines);
  editor.render(40);
  type("\x1b", "H");
  expect(editor.getCursor()).toEqual({ line: 9, col: 1 });
  type("g", "k");
  expect(editor.getCursor()).toEqual({ line: 8, col: 1 });
});
