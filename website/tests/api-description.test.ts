import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SchemaTable } from "../components/docs/api/schema-table";
import { Description } from "../components/docs/api/description";
import { getApiGroups } from "../lib/openapi";
import { getDoc } from "../lib/docs";

test("idempotency tables show a short summary and separate links to the detailed rules", () => {
  const parameters = getApiGroups().flatMap((group) => group.operations)
    .flatMap((operation) => operation.parameters)
    .filter((parameter) => parameter.name === "Idempotency-Key");
  assert.ok(parameters.length > 0);
  for (const parameter of parameters) {
    assert.ok(parameter.description!.split(/\s+/).length < 60);
    const html = renderToStaticMarkup(createElement(SchemaTable, { rows: [parameter] }));
    assert.equal([...html.matchAll(/<p>/g)].length, 2);
    const links = [...html.matchAll(/href="(\/docs\/specification\/http#[^"]+)"/g)];
    assert.equal(links.length, 2);
    for (const [, href] of links) {
      const [slug, fragment] = href.slice("/docs/".length).split("#");
      assert.ok(getDoc(slug)?.toc.some((heading) => heading.id === fragment), href);
    }
  }
});

test("API descriptions retain code spans and paragraph breaks without interpreting HTML or unsafe links", () => {
  const html = renderToStaticMarkup(createElement(Description, {
    text: "Use `Idempotency-Key`.\r\n\r\nSee [retry rules](/docs/specification/http#idempotency-and-retries). <script>bad</script> [unsafe](javascript:alert).",
  }));
  assert.match(html, /<p>Use <code>Idempotency-Key<\/code>\.<\/p><p>See <a href="\/docs\/specification\/http#idempotency-and-retries">retry rules<\/a>/);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes('href="javascript:'));
});
