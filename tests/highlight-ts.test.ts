import { describe, expect, it } from "vitest";
import { highlightTs } from "../apps/web/src/lib/highlightTs";

describe("highlightTs (code viewer)", () => {
  it("wraps keywords, strings and comments in coloured spans", () => {
    const html = highlightTs('const x = "hi"; // note');
    expect(html).toContain(">const</span>");
    expect(html).toContain('>"hi"</span>'); // string span keeps the literal quotes
    expect(html).toContain("// note</span>"); // trailing comment highlighted to end of line
    expect(html).toContain("<span");
  });

  it("escapes HTML so injected markup cannot execute", () => {
    const html = highlightTs('const a = "<img src=x onerror=alert(1)>";');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
