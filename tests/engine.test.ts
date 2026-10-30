import { expect, test } from "bun:test";
import {
  apply,
  type Buffer,
  CTRL_V,
  esc,
  overtype,
  press,
  type Register,
  type State,
} from "../src/engine.ts";

/**
 * A screen of `cols` UTF-16 units per row, showing `height` rows from row
 * `top`, for screen motions.
 */
type Screen = { cols: number; top?: number; height?: number };

/** Run keys on a buffer written as text with `|` at the cursor. */
function run(
  before: string,
  keys: string,
  textWidth?: number,
  screen?: Screen,
): string {
  const raw = before.split("\n");
  const line = raw.findIndex((l) => l.includes("|"));
  let buf: Buffer = {
    textWidth,
    lines: raw.map((l) => l.replace("|", "")),
    cursor: { line, col: raw[line].indexOf("|") },
    rows: screen && (() => rowsOf(buf.lines, screen.cols)),
    view:
      screen &&
      (() => ({ top: screen.top ?? 0, height: screen.height ?? Infinity })),
  };
  let state: State = { mode: "normal", keys: [] };
  let register: Register | undefined;
  for (const token of keys.match(/<esc>|<C-v>|./gsu) ?? []) {
    const key = token === "<C-v>" ? CTRL_V : token;
    const { cursor } = buf;
    if (key === "<esc>") {
      const result = esc(state, buf);
      state = result.state;
      buf = apply(buf, result.effects);
    } else if (state.mode === "replace") {
      buf = apply(buf, overtype(buf, key).effects);
    } else if (state.mode === "insert") {
      const to = { line: cursor.line, col: cursor.col + key.length };
      const typed = { from: cursor, to: cursor, text: key, cursor: to };
      buf = apply(buf, [{ kind: "replace", ...typed }]);
    } else {
      const result = press(state, key, buf, register);
      state = result.state;
      for (const effect of result.effects) {
        if (effect.kind === "refuse") return "refused";
        if (effect.kind === "yank") register = effect.register;
      }
      buf = apply(buf, result.effects);
    }
  }
  const { line: l, col } = buf.cursor;
  const text = buf.lines
    .map((s, i) => (i === l ? `${s.slice(0, col)}|${s.slice(col)}` : s))
    .join("\n");
  return state.mode === "normal" ? text : `${text} -- ${state.mode}`;
}

const paste = "[paste #1 +3 lines]";

test.each([
  // Motions
  ["foo b|ar", "h", "foo |bar"],
  ["|foo", "l", "f|oo"],
  ["a\n|b\nc", "j", "a\nb\n|c"],
  ["a\n|b", "j", "a\n|b"],
  ["a\n|b", "k", "|a\nb"],
  ["|foo.bar baz", "w", "foo|.bar baz"],
  ["|foo bar\nbaz", "2w", "foo bar\n|baz"],
  ["foo |bar", "b", "|foo bar"],
  ["|foo bar", "e", "fo|o bar"],
  ["  foo b|ar", "0", "|  foo bar"],
  ["  foo b|ar", "^", "  |foo bar"],
  ["f|oo", "$", "fo|o"],
  ["a\nb\n|c", "gg", "|a\nb\nc"],
  ["|a\nb\nc", "2G", "a\n|b\nc"],
  ["|a,b", "f,", "a|,b"],
  ["|ab,c", "t,", "a|b,c"],
  ["a,b|c", "F,", "a|,bc"],
  ["a,b|c", "T,", "a,|bc"],
  [`|${paste} x`, "w", `${paste} |x`],
  // Sentences, checked against Vim
  ["|One. Two! Three?", ")", "One. |Two! Three?"],
  ["One. Two! |Three?", "(", "One. |Two! Three?"],
  ["One. Tw|o", "(", "One. |Two"],
  ["|One. Two! Three?", "2)", "One. Two! |Three?"],
  ["|One. Two", "3)", "|One. Two"],
  ["One.|  Two", "2(", "One.|  Two"],
  ["|One", ")", "On|e"],
  ["|One.", "2)", "One|."],
  ["|One.", "3)", "|One."],
  ["\n|One", "2(", "|\nOne"],
  ["\n|One", "3(", "\n|One"],
  [".\n|.\naa", ")", ".\n.\na|a"],
  [".\n. \n| ", ")", ".\n|. \n "],
  [".\n.\n|))", ")", ".\n|.\n))"],
  ['|He said "Hi." Then (ok.) left.', "2)", 'He said "Hi." Then (ok.) |left.'],
  ["|a.b c. d", ")", "a.b c. |d"],
  ["|One\n\n  Two", ")", "One\n|\n  Two"],
  ["One\n|\n\n  Two", ")", "One\n\n\n  |Two"],
  ["One\n\n  |Two", "(", "One\n|\n  Two"],
  ["|One\n \nTwo", ")", "One\n \nTw|o"],
  ["é. |Next", "(", "|é. Next"],
  ['x?\n"|Hi', "(", '|x?\n"Hi'],
  [`One. |${paste} two`, "(", `|One. ${paste} two`],
  [`|One. ${paste} two`, ")", `One. |${paste} two`],
  [`|${paste}. Two`, "d)", "refused"],
  // Insert entries
  ["fo|o", "ix<esc>", "fo|xo"],
  ["f|oo", "ax<esc>", "fo|xo"],
  ["  f|oo", "Ix<esc>", "  |xfoo"],
  ["f|oo", "Ax", "foox| -- insert"],
  ["|a", "ob<esc>", "a\n|b"],
  ["|a", "Ob<esc>", "|b\na"],
  // Operators
  ["|foo bar", "dw", "|bar"],
  ["foo |bar\nbaz", "dw", "foo| \nbaz"],
  ["|a b c d", "d2w", "|c d"],
  ["|foo bar", "cwx<esc>", "|x bar"],
  ["a|bc", "d$", "|a"],
  ["ab|c", "d0", "|c"],
  ["|ab,c", "dt,", "|,c"],
  ["|a\nb\nc", "dj", "|c"],
  ["a\n|b", "dk", "|"],
  ["a\n|b\nc", "dd", "a\n|c"],
  ["a\n|b", "dd", "|a"],
  ["a\n|b\nc", "dG", "|a"],
  ["a\n|b", "ccx", "a\nx| -- insert"],
  ["f|oo bar", "diw", "| bar"],
  ["f|oo bar", "daw", "|bar"],
  ['x "a|b" y', 'ci"z<esc>', 'x "|z" y'],
  ["x 'a|b' y", "da'", "x | y"],
  ["f(a, (|b))", "di(", "f(a, (|))"],
  ["f(a, (b)|)", "da)", "|f"],
  [`|${paste} x`, "dw", "refused"],
  ["|One. Two", "d)", "|Two"],
  ["On|e", "d)", "O|n"],
  ["One. Tw|o", "d(", "One. |o"],
  ["|A. B. C.", "2d)", "|C."],
  ["|A. B", "d3)", "|A. B"],
  ["|A. B.", "d3)", "|"],
  ["|A. B.", "d4)", "|A. B."],
  ["|One\n\n", "d3)", "|"],
  [".\n|.\n", "d2)", ".\n|.\n"],
  ["\n|  ", "d2(", " | "],
  [".\n.)\n|)", "d)", ".\n|)"],
  ["|One.\n\nTwo", "d)", "|\nTwo"],
  [" |  \n\nTwo", "d)", "|\nTwo"],
  ["x\nOne. |  ", "d(", "|"],
  ["|a.\nb. \u00a0", "d2)", "|\u00a0"],
  ["|a.\nb. \u2002", "d2)", "|\u2002"],
  ["|a.\nb. \u3000", "d2)", "|\u3000"],
  ["|a.\nb. \ufeff", "d2)", "|\ufeff"],
  ['One.\n|" Two. Three.', "d)", 'One.\n|" Two. Three.'],
  ['|One.\n" Two. Three.', "d2)", '|" Two. Three.'],
  ["One. .|.. Two. Three.", "d(", "One. |.. Two. Three."],
  ["|中文. 😀 x", "d)", "|😀 x"],
  ["|One. Two", "c)X<esc>", "|XTwo"],
  ["|", "c)X<esc>", "|X"],
  ["One\n|", "c)X<esc>", "One\n|X"],
  ["|One", "c(X<esc>", "|XOne"],
  ["|One", "c2(X<esc>", "|One"],
  ["|One. Two", "y)P", "One.| One. Two"],
  ["|one. two", "gU)", "|ONE. two"],
  ["\n|one", "gU(", "|\none"],
  ["|One", "gu(", "|one"],
  [" |one.\n\n", "gU)", " |ONE.\n\n"],
  ["|\nfoo", "gUj", "|\nFOO"],
  // Edits and put
  ["|abc", "2x", "|c"],
  ["|abc", "rx", "|xbc"],
  ["|abcd", "3rx", "xx|xd"],
  ["|a b c d", "2diw", "|b c d"],
  ["|a b c d", "2daw", "|c d"],
  ["|ab\ncd\nef", "2D", "|ef"],
  ["a|b\ncd\nef", "2D", "|a\nef"],
  ["|ab", "2d$", "|ab"],
  ["a|bc", "D", "|a"],
  ["a|bc", "Cx", "ax| -- insert"],
  ["|ab", "xp", "b|a"],
  ["a[|b]", "yi[P", "a[|bb]"],
  ["|foo", "yyp", "foo\n|foo"],
  ["|foo", "yyP", "|foo\nfoo"],
  // WORDs, repeated finds, counts
  ["|a.b c", "W", "a.b |c"],
  ["a.b |c", "B", "|a.b c"],
  ["|a.b c", "E", "a.|b c"],
  ["x a.|b y", "diW", "x | y"],
  ["x a.|b y", "daW", "x |y"],
  ["|a,b,c", "f,;", "a,b|,c"],
  ["|a,b,c", "f,;,", "a|,b,c"],
  ["|a,b,c", "t,;", "a,|b,c"],
  ["|a,b,c", "2f,", "a,b|,c"],
  ["|a\nb\nc", "2dd", "|c"],
  ["|a b c d e f g h", "2d3w", "|g h"],
  ["|a", "3.", "|a"],
  // More single-key edits
  ["|abc", "2sx<esc>", "|xc"],
  ["  |ab", "Sx<esc>", "|x"],
  ["|ab", "Yp", "ab\n|ab"],
  ["|a\n  b", "J", "a| b"],
  ["|a\nb\nc", "3J", "a b| c"],
  // Small extras
  ["ab|c", "X", "a|c"],
  ["abc|d", "2X", "a|d"],
  ["|a", "yl3p", "aaa|a"],
  ["foo |bar", "ge", "fo|o bar"],
  ["a.b |c", "gE", "a.|b c"],
  ["|ab", "2~", "A|B"],
  ["|foo bar", "gUiw", "|FOO bar"],
  ["|Foo", "guu", "|foo"],
  ["|(a\nb)", "%", "(a\nb|)"],
  ["|(a\nb) c", "d%", "| c"],
  // Review fixes
  ["foo\n|bar", "db", "|bar"],
  ["|\nbar", "dw", "|bar"],
  ["|foo.bar", "dge", "|foo.bar"],
  ["|abc", "cb", "|abc"],
  ["|abc", "2dd", "|abc"],
  ["|a\nb\nc", "2gg", "a\n|b\nc"],
  ["foo bar |baz", "2ge", "fo|o bar baz"],
  ["中|a\nabcd", "j", "中a\nab|cd"],
  ["|a\nabcdef", "<C-v>jly$P", "|a a\nababcdef"],
  [" \u0301\n|x", "dd", "| \u0301"],
  // Replace mode
  ["|abc", "Rxy<esc>", "x|yc"],
  ["a|b", "Rxyz<esc>", "axy|z"],
  // Clipboard registers
  ["|ab", '"+x', "|b"],
  ["|a\nb", '2"*dd', "|"],
  ["|ab", '"ax', "|b"],
  ["|ab", 'vl"+d', "|"],
  ["|1\n2\n3\n4\n5\n6\n7", '2"+3dd', "|7"],
  ["|ab", '"+"*x', "|b"],
  ["|ab cd", 'yiwwve"+p', "ab |ab"],
  // Visual mode
  ["|ab", "vl", "a|b -- visual"],
  ["|ab", "vl<esc>", "a|b"],
  ["|foo bar baz", "vwd", "|ar baz"],
  ["|foo bar", "vecx<esc>", "|x bar"],
  ["a|bc", "vlohd", "|"],
  ["|One. Two", "v)d", "|wo"],
  ["|One.\n\nTwo", "v)d", "|Two"],
  ["|\nTwo", "v(d", "|Two"],
  ["One. Two. |Three", "v(d", "One. |hree"],
  ["x\n|ab\ncd", "vjld", "x\n|"],
  ["|a\nb\nc", "Vjd", "|c"],
  ["f|oo bar", "viwd", "| bar"],
  ["|ab", "vlyP", "a|bab"],
  ["|ab cd", "yiwwvep", "ab |ab"],
  ["|abc", "vlrx", "|xxc"],
  ["|ab", "vlU", "|AB"],
  ["|a\nb\nc", "VjJ", "a| b\nc"],
  ["|a\nb", "Vj>", "  |a\n  b"],
  // Indent
  ["|a\nb", "2>>", "  |a\n  b"],
  ["  |a", "<<", "|a"],
  // Visual block
  ["|abc\nabc\nabc", "<C-v>jjld", "|c\nc\nc"],
  ["|abc\nabc", "<C-v>jlrx", "|xxc\nxxc"],
  ["|ab\nabcd", "<C-v>j$d", "|\n"],
  ["a|bc\nabc", "<C-v>jlOhd", "|\n"],
  ["|abc\nabc", "<C-v>jly$p", "abc|ab\nabcab"],
  ["|abc\nabc", "<C-v>jc", "|bc\nbc -- insert"],
])("%j + %j → %j", (before, keys, after) => {
  expect(run(before, keys)).toBe(after);
});

function rowsOf(lines: readonly string[], cols: number) {
  return lines.flatMap((l, line) =>
    Array.from({ length: Math.max(1, Math.ceil(l.length / cols)) }, (_, i) => ({
      line,
      start: i * cols,
      length: Math.min(cols, l.length - i * cols),
    })),
  );
}

// Screen-row motions on rows of `cols` characters.
test.each([
  ["a|bcdefgh", "gj", 4, "abcde|fgh"],
  ["abcde|fgh", "gk", 4, "a|bcdefgh"],
  ["a|bcdefgh\nxy", "2gj", 4, "abcdefgh\nx|y"],
  ["abc|d\nxy", "gj", 4, "abcd\nx|y"],
  ["abcd|efgh", "gj", 4, "abcd|efgh"],
  ["|abcd", "gk", 4, "|abcd"],
  ["a|bcdefgh", "dgj", 4, "a|fgh"],
  ["a|bcdefgh", "vgjd", 4, "a|gh"],
  ["abcdef|gh", "g0", 4, "abcd|efgh"],
  ["abcd|  ef", "g^", 4, "abcd  |ef"],
  ["abcd|efgh", "g$", 4, "abcdefg|h"],
  ["a|bcdefgh", "2g$", 4, "abcdefg|h"],
  ["a|bcdefgh", "dg$", 4, "a|efgh"],
  ["abcd|   ", "g^", 4, "abcd  | "],
  // Counts past the last row move as far as they can, but operators fail.
  ["a|bcdefgh", "3gj", 4, "abcde|fgh"],
  ["a|bcdefgh", "d2gj", 4, "a|bcdefgh"],
  ["abcde|fgh", "d2gk", 4, "abcde|fgh"],
  ["a|bcdefgh", "3g$", 4, "abcdefg|h"],
  // Display columns: wide characters, and a wrapped paste marker's tail.
  ["中|文\nabcd", "gj", 80, "中文\nab|cd"],
  [`${paste}|a\n0123456789`, "gj", 10, `${paste}a\n012345678|9`],
  // A wrapped paste marker's inner rows can't hold the cursor.
  [`|${paste} x`, "gj", 5, `${paste}| x`],
  // `H` `M` `L` move to a first non-blank, so they end block `$`.
  ["abc|def\nabcdef\nabcdef", "<C-v>$Ld", 80, "|ef\nef\nef"],
])("%j + %j at width %j → %j", (before, keys, cols, after) => {
  expect(run(before, keys, undefined, { cols })).toBe(after);
});

// `H` `M` `L` on the visible rows (here lines b to d) go to the first
// non-blank, linewise.
const view = "a\n|b\n  c\nd\ne";
test.each([
  [view, "H", "a\n|b\n  c\nd\ne"],
  [view, "M", "a\nb\n  |c\nd\ne"],
  [view, "L", "a\nb\n  c\n|d\ne"],
  [view, "2H", "a\nb\n  |c\nd\ne"],
  [view, "2L", "a\nb\n  |c\nd\ne"],
  [view, "9H", "a\nb\n  c\n|d\ne"],
  [view, "dL", "a\n|e"],
  [view, "VLd", "a\n|e"],
])("%j + %j → %j", (before, keys, after) => {
  expect(run(before, keys, undefined, { cols: 80, top: 1, height: 3 })).toBe(
    after,
  );
});

test("H on a wrapped row lands on its first non-blank", () => {
  const screen = { cols: 4, top: 1, height: 1 };
  expect(run("abcd|  ef", "H", undefined, screen)).toBe("abcd  |ef");
});

// Without a layout, each line is one row, and nothing is known visible.
test.each([
  ["a|b\ncd", "gj", "ab\nc|d"],
  ["a|bc", "g$", "ab|c"],
  ["a\n|b\nc", "H", "a\n|b\nc"],
])("unwrapped: %j + %j → %j", (before, keys, after) => {
  expect(run(before, keys)).toBe(after);
});

// Backticks use the same line-local pairing as single and double quotes.
test.each([
  ["`src/|old.ts`", "ci`", "`|` -- insert"],
  ["`src/|old.ts`", "ci`src/new.ts<esc>", "`src/new.t|s`"],
  ["x |`ab` y", "di`", "x `|` y"],
  ["x `a|b` y", "di`", "x `|` y"],
  ["x `ab|` y", "di`", "x `|` y"],
  ["x `a|b` y", "da`", "x | y"],
  ["x `a|b` y", "ca`z<esc>", "x |z y"],
  ["x `a|b` y", "yi`P", "x `a|bab` y"],
  ["x `a|b` y", "ya`P", "x `ab|``ab` y"],
  ["x `A|B` y", "gui`", "x `|ab` y"],
  ["x `a|b` y", "gUa`", "x |`AB` y"],
  // Look forward to the next pair, but never backward or across lines.
  ["|before `ab`", "di`", "before `|`"],
  ["`ab` |between `cd`", "di`", "`ab` between `|`"],
  ["`ab` a|fter", "di`", "`ab` a|fter"],
  ["|`unclosed", "di`", "|`unclosed"],
  ["`|one\ntwo`", "di`", "`|one\ntwo`"],
  ["|no pair\n`ab`", "di`", "|no pair\n`ab`"],
  ["`a\\`|b`", "di`", "`|`"],
  ["`a\\\\|` tail", "di`", "`|` tail"],
  // Empty inner objects still let change enter INSERT.
  ["|``", "ci`x<esc>", "`|x`"],
  ["|``", "di`", "|``"],
  ["x |`` y", "da`", "x | y"],
  ["`中|文👨‍👩‍👧‍👦e\u0301`", "ci`新<esc>", "`|新`"],
  ["x `a|b` y", "vi`d", "x `|` y"],
  ["x `a|b` y", "va`d", "x | y"],
  ["x `a|b` y", "Vi`d", "x `|` y"],
  ["x `a|b` y", "<C-v>a`d", "x | y"],
  ["`|e\u0301👨‍👩‍👧‍👦`", "vi`d", "`|`"],
  ["|``", "vi`", "|`` -- visual"],
  // Counts remain unsupported, just like other quote objects.
  ["`a|b`", "2di`", "`a|b`"],
  ["`a|b`", "d2a`", "`a|b`"],
  ["`a|b`", "v2i`", "`a|b` -- visual"],
])("backtick object: %j + %j → %j", (before, keys, after) => {
  expect(run(before, keys)).toBe(after);
});

test.each(["di`", "ca`", "yi`", "gui`", "gUa`", "vi`d", "va`y"])(
  "refuses backtick objects touching paste markers: %s",
  (keys) => {
    expect(run(`\`|${paste}\``, keys)).toBe("refused");
  },
);

// Sentence objects: public Vim object-select semantics, checked with Vim.
test.each([
  ["On|e. Two.", "dis", "| Two."],
  ["On|e. Two.", "das", "|Two."],
  ["One. Tw|o. Three.", "cisX<esc>", "One. |X Three."],
  ["One. Tw|o. Three.", "casX<esc>", "One. |XThree."],
  ["one. tw|o! three?", "gUis", "one. |TWO! three?"],
  ["ONE. TW|O! THREE?", "guas", "ONE. |two! THREE?"],
  ["One. Tw|o. Three.", "yis", "One. |Two. Three."],
  ["One. Tw|o.", "yas", "One.| Two."],
  ["One.|  Two. Three.", "dis", "One.|Two. Three."],
  ["One. | Two. Three.", "das", "One.| Three."],
  ["One. Tw|o.", "das", "One|."],
  ["  O|ne. Two.", "dis", "| Two."],
  ["One.\n | Two. Three.", "dis", "One.\n|Two. Three."],
  ["One.  \n | Two. Three.", "dis", "One.|Two. Three."],
  ["|One. Two. Three.", "2dis", "|Two. Three."],
  ["|One. Two. Three.", "d3is", "| Three."],
  ["One.|  Two. Three.", "d2is", "One.| Three."],
  ["|One. Two. Three.", "d2as", "|Three."],
  ["|A. B. C. D. E. F. G.", "2d3as", "|G."],
  ["|A. B. C. D. E.", "2d3is", "|D. E."],
  ["|one. two. three.", "2gUas", "|ONE. TWO. three."],
  ["|One. Two.", "d99is", "|"],
  ["|One. Two.", "d99as", "|"],
  ["|One.  ", "dis", "|  "],
  ["|One.  ", "das", "|"],
  ["One.|  ", "das", "One.|  "],
  ["One.|  ", "d2is", "One.|  "],
  ["|", "dis", "|"],
  ["|", "cisX<esc>", "|X"],
  ["One.\n|", "casX<esc>", "One.\n|X"],
  ["|  ", "dis", "|"],
  ["|  ", "das", "| "],
  ["| \n", "das", "|"],
  ["|Unfinished sentence", "das", "|"],
  ['He said "H|i!")] Next.', "dis", "| Next."],
  ["a.b |still one. Next.", "das", "|Next."],
  ["|One.\nTwo.", "dis", "|Two."],
  ["On|e.\nTwo.", "yis", "|One.\nTwo."],
  ["  On|e.\nTwo.", "gUis", "|  ONE.\nTwo."],
  ["On|e.\nTwo.", "cisX<esc>", "|X\nTwo."],
  ["|One.\n  Two.", "das", "|Two."],
  ["First. Sec|ond\ncontinues. Third.", "dis", "First. | Third."],
  [
    "First. sec|ond\ncontinues. Third.",
    "gUis",
    "First. |SECOND\nCONTINUES. Third.",
  ],
  ["|One\n \nTwo.", "dis", "|"],
  ["|One\n\nTwo.", "das", "|\nTwo."],
  ["One\n|\nTwo.", "dis", "One\n|Two."],
  ["One\n|\n\nTwo.", "das", "One\n\n|Two."],
  ["One\n\n  T|wo.", "dis", "One\n\n | "],
  ["One\n\n  T|wo.", "das", "One\n\n|"],
  ["é\u0301 👨‍👩‍👧‍👦 |中文.\u0301 Next.", "dis", "| Next."],
  ["|One.\u00a0Still one. Next.", "das", "|Next."],
  [`One. ${paste} t|wo. Three.`, "dis", "refused"],
  [`One. ${paste} t|wo. Three.`, "cas", "refused"],
  [`One. ${paste} t|wo. Three.`, "gUis", "refused"],
  [`One. ${paste} t|wo. Three.`, "yis", "refused"],
  [`|One. ${paste} two.`, "das", `|${paste} two.`],
  // Visual objects are characterwise, extend in either direction, and count.
  ["On|e. Two.", "visd", "| Two."],
  ["On|e. Two.", "vasd", "|Two."],
  ["|One. Two. Three.", "v2isd", "|Two. Three."],
  ["|One. Two. Three.", "v2asd", "|Three."],
  ["|One. Two. Three.", "visisd", "|Two. Three."],
  ["|One. Two. Three.", "vasasd", "|Three."],
  ["One. |Two. Three.", "visoisd", "One.| Three."],
  ["One. |Two. Three.", "vasoasd", "|Three."],
  ["One\n|\n\nTwo.", "visoisd", "One\n\n|Two."],
  ["One\n\n|  Two.", "vasoasd", "One\n\n|"],
  ["One.\nTwo.\n|Three.", "viso2isd", "|"],
  ["One\n|\n\nTwo.", "viso2isd", "|Two."],
  ["One.\n\n  |Three.", "vaso2asd", "One.\n|"],
  ["On|e. Two. Three.", "vllisd", "On| Three."],
  ["One.\nTw|o\ncontinues. Three.", "visd", "One.\n| Three."],
  ["|One.\nTwo.", "visd", "|\nTwo."],
  ["|One.\nTwo.", "vasd", "|\nTwo."],
  ["|One.\nTwo.", "visisd", "|"],
  ["|One.\n  Two.", "vasd", "|Two."],
  ["|One\n\nTwo.", "visd", "|\n\nTwo."],
  ["One. T|wo.", "Visd", "One.| "],
  ["One. T|wo.", "<C-v>asd", "One|."],
  ["|One 👨‍👩‍👧‍👦\n\nTwo.", "visd", "|\n\nTwo."],
  [`One. ${paste} t|wo.`, "visd", "refused"],
  // Other objects stay line-local, including their Visual endpoints.
  ['x "a|b" y', 'vi"d', 'x "|" y'],
  ["x (a|b) y", "va)d", "x | y"],
  ["f|oo\nbar", "viwd", "|\nbar"],
  ["(|one\ntwo)", "di(", "(|one\ntwo)"],
])("sentence object: %j + %j → %j", (before, keys, after) => {
  expect(run(before, keys)).toBe(after);
});

// Paragraph motions use empty lines, not the objects' space/tab separators.
// Representative boundaries and operator shapes checked with vim -Nu NONE.
test.each([
  ["|one\ntwo\n\nthree", "}", "one\ntwo\n|\nthree"],
  ["one\n\n\n|two", "{", "one\n\n|\ntwo"],
  ["one\n|\n\ntwo\n\nthree", "}", "one\n\n\ntwo\n|\nthree"],
  ["one\n\n|\ntwo", "{", "|one\n\n\ntwo"],
  ["|one\n \n\t\ntwo", "}", "one\n \n\t\ntw|o"],
  ["one\n \n\t\n|two", "{", "|one\n \n\t\ntwo"],
  ["|one\n\n\ntwo\n\nthree", "2}", "one\n\n\ntwo\n|\nthree"],
  ["one\n\n\ntwo\n\n|three", "2{", "one\n\n|\ntwo\n\nthree"],
  ["|one\n\ntwo", "3}", "|one\n\ntwo"],
  ["one\n\n|two", "3{", "one\n\n|two"],
  ["|one", "}", "on|e"],
  ["on|e", "}", "on|e"],
  ["on|e", "{", "|one"],
  ["on|e", "2{", "on|e"],
  ["|one", "9999}", "|one"],
  ["|one", "{", "|one"],
  ["|one", "gU{", "|One"],
  ["|one", "c{X<esc>", "|Xone"],
  ["|", "c{X<esc>", "|X"],
  ["|", "c}X<esc>", "|X"],
  ["|", "}", "|"],
  ["|\n\n", "}", "\n\n|"],
  ["\n\n|", "{", "|\n\n"],
  ["|one\n\n", "2}", "one\n\n|"],
  ["|one\n\n", "3}", "|one\n\n"],
  ["|one\n", "2}", "|one\n"],
  ["|one\ntwo\n\nthree", "d}", "|\nthree"],
  ["o|ne\ntwo\n\nthree", "d}", "|o\n\nthree"],
  ["  |one\ntwo\n\nthree", "d}", "|\nthree"],
  ["one\n\n|two", "d{", "one\n|two"],
  ["one\n\ntw|o", "d{", "one\n|o"],
  ["|one\ntwo", "d}", "|"],
  ["on|e", "d}", "o|n"],
  ["|one", "d2}", "|one"],
  ["one\n\n|two", "d3{", "one\n\n|two"],
  ["|a\n\nb\n\nc\n\nd\n\ne", "2d2}", "|\ne"],
  ["|one\ntwo\n\nthree", "c}X<esc>", "|X\n\nthree"],
  ["o|ne\ntwo", "c}X<esc>", "o|X"],
  ["|one\ntwo\n\nthree", "gU}", "|ONE\nTWO\n\nthree"],
  ["ONE\n\nTW|O", "gu{", "ONE\n|\ntwO"],
  ["|one\n\ntwo\n\nthree", "gU2}", "|ONE\n\nTWO\n\nthree"],
  ["|one\n\ntwo", "v}", "one\n|\ntwo -- visual"],
  ["|one\n\ntwo", "V}", "one\n|\ntwo -- vline"],
  ["|one\n\ntwo", "v}d", "|two"],
  ["|one\n\ntwo", "V}d", "|two"],
  ["one\n\n|two", "v{d", "one\n|wo"],
  ["|one\n\ntwo", "v3}", "|one\n\ntwo -- visual"],
  ["|one\n\ntwo", "<C-v>}", "one\n|\ntwo -- vblock"],
  ["|中文\né👨‍👩‍👧‍👦", "}", "中文\né|👨‍👩‍👧‍👦"],
  ["中文\né|👨‍👩‍👧‍👦", "d}", "中文\n|é"],
  ["|one\né", "v}d", "|"],
  [`|one\n${paste}`, "}", `one\n|${paste}`],
  // Deliberate subset: no nroff, section, or Markdown boundaries.
  [
    "|one\n.PP\n.SH\n\f\n{\n}\n# Heading\n- item\n```\nend",
    "}",
    "one\n.PP\n.SH\n\f\n{\n}\n# Heading\n- item\n```\nen|d",
  ],
])("paragraph motion: %j + %j → %j", (before, keys, after) => {
  expect(run(before, keys)).toBe(after);
});

test.each(["d}", "c}", "y}", "gu}", "gU}", "v}d", "V}y"])(
  "refuses paragraph motions touching paste markers: %s",
  (keys) => {
    expect(run(`|one\n${paste}\n\nafter`, keys)).toBe("refused");
  },
);

// Paragraph objects are whole-line runs; their blanks include spaces and tabs.
test.each([
  ["before\n\nal|pha\nbeta\n\nafter", "dip", "before\n\n|\nafter"],
  ["before\n\nal|pha\nbeta\n\nafter", "dap", "before\n\n|after"],
  ["A\n\n|B", "dap", "|A"],
  ["|A\nB", "dap", "|"],
  ["A\n|\n \n\t\nB", "dip", "A\n|B"],
  ["A\n|\n \n\t\nB\n\nC", "dap", "A\n|\nC"],
  ["|A\n \nB", "dip", "| \nB"],
  ["|A\n\t\nB", "dap", "|B"],
  ["|A\n \t\nB", "dap", "|B"],
  ["|A\n\u00a0\nB", "dip", "|"],
  ["|A\n\u2002\nB", "dip", "|"],
  ["A\n|\n", "dap", "A\n|\n"],
  ["|", "dap", "|"],
  ["|", "cipX<esc>", "|X"],
  ["A\n|\nB", "cipX<esc>", "A\n|X\nB"],
  ["A\n\n  al|pha\n  beta\n\nB", "cipX<esc>", "A\n\n|X\n\nB"],
  ["|A\n\n\nB\n\nC", "d2ip", "|B\n\nC"],
  ["|A\n\n\nB\n\nC", "d3ip", "|\nC"],
  ["|A\n\nB\n\nC", "2dap", "|C"],
  ["A\n\n|B\n\nC", "d2ap", "|A"],
  ["A\n\n|B", "d2ip", "A\n\n|B"],
  ["|A\n\nB", "d3ap", "|A\n\nB"],
  ["|A\n\nB\n\nC\n\nD\n\nE\n\nF\n\nG", "2d3ap", "|G"],
  ["|A\n\nB\n\nC\n\nD", "3d2ip", "|D"],
  ["|one\ntwo\n\nthree", "gUip", "|ONE\nTWO\n\nthree"],
  ["|ONE\n\nTWO\n\nTHREE", "gu2ap", "|one\n\ntwo\n\nTHREE"],
  ["|one\n\ntwo\n\nthree", "2gUap", "|ONE\n\nTWO\n\nthree"],
  ["e\u0301 |中文\n👨‍👩‍👧‍👦\n\nNext", "cip新<esc>", "|新\n\nNext"],
  // Linewise puts keep the paragraph's rows, rather than joining its text.
  ["|A\nB\n\nC", "yipGP", "A\nB\n\n|A\nB\nC"],
  ["|A\nB\n\nC", "vipd", "|\nC"],
  ["|A\nB\n\nC", "vapd", "|C"],
  ["|A\nB\n\nC", "Vipd", "|\nC"],
  ["|A\nB\n\nC", "<C-v>ipd", "|\nC"],
  ["|AA\naaa\n\nB", "vlipd", "|\nB"],
  ["|AA\naaa\n\nB", "vjipd", "|B"],
  ["|A\na\n\nB\nb\n\nC", "vipipd", "|B\nb\n\nC"],
  ["|A\na\n\nB\nb\n\nC", "vipapd", "|\nC"],
  ["A\na\n\n|B\nb\n\nC", "vipoipd", "A\na\n|\nC"],
  ["A\na\n\n|B\nb\n\nC", "vipoapd", "|\nC"],
  ["|A\n\nB", "vipipd", "|B"],
  ["|A\n\nB", "Vipd", "|B"],
  ["|A\n\nB\n\nC", "v2ipd", "|B\n\nC"],
  ["|A\n\nB\n\nC", "v2apd", "|C"],
])("paragraph object: %j + %j → %j", (before, keys, after) => {
  expect(run(before, keys)).toBe(after);
});

test.each(["dip", "cap", "yip", "guip", "gUap", "vipd", "vapy"])(
  "refuses paragraph objects touching paste markers: %s",
  (keys) => {
    expect(run(`A\n\n|text\n${paste}\n\nB`, keys)).toBe("refused");
  },
);

test("paragraph counts refuse adjacent paste content, not untouched paragraphs", () => {
  expect(run(`A\n|\n${paste}\n\nB`, "dap")).toBe("refused");
  expect(run(`|A\n\n${paste}`, "dip")).toBe(`|\n${paste}`);
});

test.each([
  ["one two three four |five six", "gwap", "one two\nthree four\n|five six"],
  ["one two\nthree |four\nfive six", "gwip", "one two\nthree |four\nfive six"],
  [
    "one two three four |five six\n\nnext",
    "gqap",
    "one two\nthree four\nfive six\n|\nnext",
  ],
  [
    "one two three four |five six\n\nnext",
    "gqip",
    "one two\nthree four\n|five six\n\nnext",
  ],
  ["|one two three four\n\nnext", "gq}", "one two\nthree four\n|\nnext"],
  ["|one two three.\nfour five six", "gq)", "one two\nthree.\n|four five six"],
  [
    "one two three four\nfive six |seven eight",
    "gqk",
    "one two\nthree four\nfive six\n|seven eight",
  ],
  [
    "|one two three four\nfive six seven eight",
    "2gqq",
    "one two\nthree four\nfive six\n|seven eight",
  ],
  [
    "|one two three four\nfive six seven eight",
    "gq2q",
    "one two\nthree four\nfive six\n|seven eight",
  ],
  ["|one two three four", "gqgq", "one two\n|three four"],
  ["one two three |four", "gww", "one two\nthree |four"],
  [
    "|one two three four\nfive six seven eight",
    "2gwgw",
    "|one two\nthree four\nfive six\nseven eight",
  ],
  [
    "|one two three four\nfive six seven eight",
    "gw2gw",
    "|one two\nthree four\nfive six\nseven eight",
  ],
  [
    "|one two three four\nfive six seven eight",
    "2gww",
    "|one two\nthree four\nfive six seven eight",
  ],
  [
    "|one two three four\nfive six seven eight",
    "gw2w",
    "|one two\nthree four\nfive six seven eight",
  ],
  [
    "|one two three four\nfive six seven eight",
    "Vjgw",
    "one two\nthree four\n|five six\nseven eight",
  ],
  ["one |two three four", "viwgq", "one two\n|three four"],
  [
    "|one two three four\nfive six seven eight",
    "<C-v>jgq",
    "one two\nthree four\nfive six\n|seven eight",
  ],
  [
    "one two\nthree |four. Five six seven.",
    "gwis",
    "one two\nthree |four.\nFive six\nseven.",
  ],
  [
    "|one two three four\n \n\t\nfive six seven eight",
    "gq2ap",
    "one two\nthree four\n \n\t\nfive six\n|seven eight",
  ],
  [
    "  one |two three four\n    five six",
    "gwap",
    "  one |two\n  three four\n  five six",
  ],
  [" | one two three four", "gwap", " | one two\n  three four"],
  ["|one  two   three four five", "gqq", "one  two\nthree four\n|five"],
  ["one two| three four", "gww", "one tw|o\nthree four"],
  ["|unbreakablelongword two three", "gqq", "unbreakablelongword\n|two three"],
  ["|界界 界界 界界", "gqq", "界界 界界\n|界界"],
  ["|👩‍💻👩‍💻 👩‍💻👩‍💻 👩‍💻👩‍💻", "gqq", "👩‍💻👩‍💻 👩‍💻👩‍💻\n|👩‍💻👩‍💻"],
  ["|éééé éééé éééé", "gqq", "éééé éééé\n|éééé"],
  ["|\tone two three", "gqq", "\tone\n\ttwo\n\t|three"],
] as const)("manually reflows prose: %j + %s", (before, keys, after) => {
  expect(run(before, keys, 12)).toBe(after);
});

test.each(["gwap", "gqap", "gwiw", "viwgq", "<C-v>jgq"])(
  "refuses formatting if any touched line contains a paste: %s",
  (keys) => {
    expect(run(`|one two three four ${paste}\nnext`, keys, 12)).toBe("refused");
  },
);
