import { describe, expect, it } from "vitest";

import { parseInlineMath } from "./inlineMath";

describe("parseInlineMath", () => {
  it("accepts a whole-text expression in each delimiter style", () => {
    expect(parseInlineMath("$x^2$")).toEqual({
      latex: "x^2",
      open: "$",
      close: "$",
    });
    expect(parseInlineMath("  $$\\frac{a}{b}$$ ")).toEqual({
      latex: "\\frac{a}{b}",
      open: "$$",
      close: "$$",
    });
    expect(parseInlineMath("\\(a+b\\)")).toEqual({
      latex: "a+b",
      open: "\\(",
      close: "\\)",
    });
    expect(parseInlineMath("\\[\\sum_i i\\]")).toEqual({
      latex: "\\sum_i i",
      open: "\\[",
      close: "\\]",
    });
  });

  it("rejects prose, empty and mixed input", () => {
    expect(parseInlineMath("hello")).toBeNull();
    expect(parseInlineMath("$$")).toBeNull();
    expect(parseInlineMath("$ $")).toBeNull();
    expect(parseInlineMath("$a$ and $b$")).toBeNull();
    expect(parseInlineMath("see $x$")).toBeNull();
    expect(parseInlineMath(null)).toBeNull();
  });
});
