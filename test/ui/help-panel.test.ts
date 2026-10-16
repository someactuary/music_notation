import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HelpPanel } from "@/ui/HelpPanel";
import { FAQ, parseInline } from "@/ui/help-faq";

describe("parseInline", () => {
  it("splits `keys` and **bold** out of plain text", () => {
    expect(parseInline("Press `Shift`+`E` for **one** note")).toEqual([
      { kind: "text", text: "Press " },
      { kind: "key", text: "Shift" },
      { kind: "text", text: "+" },
      { kind: "key", text: "E" },
      { kind: "text", text: " for " },
      { kind: "bold", text: "one" },
      { kind: "text", text: " note" },
    ]);
  });

  it("leaves an unmatched marker as literal text", () => {
    expect(parseInline("a ` b ** c")).toEqual([{ kind: "text", text: "a ` b ** c" }]);
  });
});

describe("FAQ content", () => {
  it("has unique ids and a non-empty question and answer for every entry", () => {
    expect(new Set(FAQ.map((e) => e.id)).size).toBe(FAQ.length);
    for (const e of FAQ) {
      expect(e.question.trim()).not.toBe("");
      expect(e.answer.length).toBeGreaterThan(0);
    }
  });

  it("starts with the chord entry", () => {
    expect(FAQ[0]!.id).toBe("chords");
  });
});

describe("HelpPanel", () => {
  it("renders each question with its answer, keys as <kbd>", () => {
    const html = renderToStaticMarkup(createElement(HelpPanel, { onClose: () => {} }));
    expect(html).toContain("Help &amp; FAQ");
    expect(html).toContain("How do I enter a chord?");
    expect(html).toContain("<kbd>Shift</kbd>");
    expect(html).toContain("<strong>selected</strong>");
  });

  it("shows a lone entry open and several entries collapsed", () => {
    const one = renderToStaticMarkup(createElement(HelpPanel, { onClose: () => {}, entries: [FAQ[0]!] }));
    expect(one).toMatch(/<details[^>]* open=""/);
    const two = renderToStaticMarkup(
      createElement(HelpPanel, { onClose: () => {}, entries: [FAQ[0]!, { ...FAQ[0]!, id: "copy" }] }),
    );
    expect(two).not.toMatch(/<details[^>]* open/);
  });
});
