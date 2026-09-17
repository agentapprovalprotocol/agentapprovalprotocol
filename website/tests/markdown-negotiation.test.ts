import assert from "node:assert/strict";
import test from "node:test";
import { negotiateDocument, type DocumentFormat } from "../lib/markdown-negotiation";

function check(cases: [string | null, DocumentFormat | null][]) {
  for (const [accept, expected] of cases) assert.equal(negotiateDocument(accept), expected, String(accept));
}

test("Accept Markdown's core negotiation examples select an available representation", () => {
  check([
    ["text/markdown", "markdown"],
    ["text/markdown, text/html;q=0.8", "markdown"],
    ["text/markdown, text/plain;q=0.5, */*;q=0.1", "markdown"],
    ["text/html", "html"],
    ["text/markdown;q=0, text/html", "html"],
    [null, "html"],
    ["*/*", "html"],
    ["text/*", "html"],
    ["text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8", "html"],
  ]);
});

test("unsatisfiable Accept values return no representation instead of silently choosing HTML", () => {
  check([
    ["application/pdf", null], ["application/json", null], ["text/plain", null],
    ["application/markdown", null], ["text/markdown-extra", null],
    ["", null], ["   ", null], ["*/*;q=0", null], ["text/*;q=0", null],
    ["text/markdown;q=0", null], ["text/html;q=0", null],
    ["text/html;q=0, text/markdown;q=0", null],
    ["text/html;q=0, text/markdown;q=0, */*", null],
  ]);
});

test("quality weights select the preferred representation and explicit Markdown wins ties", () => {
  check([
    ["text/html, text/markdown", "markdown"],
    ["text/markdown, text/html", "markdown"],
    ["text/html;q=0.5, text/markdown;q=0.5", "markdown"],
    ["text/html;q=0.5, text/markdown;q=0.6", "markdown"],
    ["text/markdown;q=0.5, text/html;q=0.6", "html"],
    ["text/markdown;q=0.001, text/html;q=0", "markdown"],
    ["text/markdown;q=1.000, text/html", "markdown"],
    ["text/markdown;q=0.4, text/markdown;q=0.8, text/html;q=0.7", "markdown"],
    ["application/pdf, text/html;q=0.1", "html"],
  ]);
});

test("specific ranges override wildcards for both representations, including rejections", () => {
  check([
    ["text/markdown, */*", "markdown"],
    ["text/markdown;q=0.8, */*", "html"],
    ["text/markdown;q=0.8, text/*;q=0.9", "html"],
    ["text/markdown;q=0.8, text/*;q=0.5, */*", "markdown"],
    ["*/*, text/*;q=0.5, text/markdown;q=0.8", "markdown"],
    ["text/markdown;q=0.8, text/html;q=0.5, text/*", "markdown"],
    ["text/markdown;q=0.8, text/html;q=0, */*", "markdown"],
    ["text/markdown;q=0, */*", "html"],
    ["text/markdown;q=0, text/*", "html"],
    ["text/html;q=0, */*", "markdown"],
    ["text/html;q=0, text/*", "markdown"],
    ["text/html;q=0.5, */*", "markdown"],
    ["text/*;q=0, */*", null],
    ["application/pdf, */*;q=0.1", "html"],
  ]);
});

test("UTF-8 parameters match case-insensitively and more specific parameters take precedence", () => {
  check([
    ["TEXT/MARKDOWN", "markdown"], [" text/markdown ; Q = 0.8 ", "markdown"],
    ["text/markdown; charset=utf-8", "markdown"],
    ['text/markdown; CHARSET="UTF-8"', "markdown"],
    ["text/markdown;charset=iso-8859-1", null],
    ["text/markdown;variant=unknown, text/html", "html"],
    ["text/markdown;charset=utf-8;q=0, text/markdown", null],
    ["text/markdown, text/markdown;charset=utf-8;q=0", null],
    ["text/markdown;charset=utf-8;q=0, text/*", "html"],
    ["text/html;charset=utf-8;q=0, text/*", "markdown"],
  ]);
});

test("invalid weights cannot make Markdown acceptable", () => {
  for (const weight of ["", "-1", "2", "1.001", "0.1234", "NaN", "Infinity", "0.5junk", '"0.5"', ".5", "1e0"]) {
    assert.equal(negotiateDocument(`text/markdown;q=${weight}, */*`), "html", weight);
    assert.equal(negotiateDocument(`text/markdown;q=${weight}`), null, weight);
  }
  check([["text/markdown;q", null], ["text/markdown;q=0;q=1", null]]);
});

test("quoted parameters cannot be mistaken for acceptable media ranges", () => {
  check([
    ['text/html;note="example, text/markdown"', null],
    ['text/html;note="unfinished, text/markdown', null],
    ['application/json;note="example, text/markdown", text/html', "html"],
    ['text/markdown;note="example;q=0, text/html";q=1', null],
  ]);
});
