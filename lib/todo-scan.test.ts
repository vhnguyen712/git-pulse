import { describe, it, expect } from "vitest";
import { scanText } from "./todo-scan";
import { todoTitle } from "./todo-items";

describe("scanText", () => {
  it("captures each marker with its line number and trailing text", () => {
    const src = [
      "const x = 1;",
      "// TODO: refactor this once the API stabilizes",
      "function f() {}",
      "/* FIXME handle the null case */",
    ].join("\n");

    const found = scanText("src/a.ts", src);
    expect(found).toEqual([
      { file: "src/a.ts", line: 2, marker: "TODO", text: "refactor this once the API stabilizes" },
      { file: "src/a.ts", line: 4, marker: "FIXME", text: "handle the null case */" },
    ]);
  });

  it("records a bare marker with empty text", () => {
    const found = scanText("a.py", "# HACK\nx = 1");
    expect(found).toEqual([{ file: "a.py", line: 1, marker: "HACK", text: "" }]);
  });

  it("matches all four marker kinds", () => {
    const src = "TODO a\nFIXME b\nHACK c\nXXX d";
    expect(scanText("f", src).map((f) => f.marker)).toEqual(["TODO", "FIXME", "HACK", "XXX"]);
  });

  it("requires whole-word, uppercase markers", () => {
    // "TODOLIST" is not a TODO; lowercase "todo" is not matched.
    const src = "const TODOLIST = [];\n// just a todo note\nMYFIXME";
    expect(scanText("f", src)).toEqual([]);
  });

  it("returns nothing for text with no markers", () => {
    expect(scanText("f", "hello\nworld")).toEqual([]);
  });
});

describe("todoTitle", () => {
  it("encodes marker + text, and is stable across line changes (idempotency key)", () => {
    const a = todoTitle({ file: "src/a.ts", line: 2, marker: "TODO", text: "wire up retries" });
    const b = todoTitle({ file: "src/a.ts", line: 99, marker: "TODO", text: "wire up retries" });
    expect(a).toBe("TODO: wire up retries");
    expect(a).toBe(b); // line moved, same title → no duplicate on re-scan
  });

  it("falls back to the file's basename for a bare marker", () => {
    expect(todoTitle({ file: "src/deep/mod.ts", line: 1, marker: "FIXME", text: "" })).toBe(
      "FIXME in mod.ts",
    );
  });

  it("truncates very long text with an ellipsis", () => {
    const long = "x".repeat(200);
    const title = todoTitle({ file: "f", line: 1, marker: "TODO", text: long });
    expect(title.length).toBeLessThanOrEqual("TODO: ".length + 120);
    expect(title.endsWith("…")).toBe(true);
  });
});
