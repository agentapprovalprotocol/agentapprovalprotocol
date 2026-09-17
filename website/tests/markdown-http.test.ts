import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { getAllDocs } from "../lib/docs";
import { specPath } from "../lib/openapi";

// Run against a production server with AAP_TEST_BASE_URL=http://127.0.0.1:3018 npm test.
const baseUrl = process.env.AAP_TEST_BASE_URL;
const options = { skip: !baseUrl };
function fetchPage(path: string, accept = "text/markdown", init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("accept", accept);
  return fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(20_000), ...init, headers });
}

function assertVary(response: Response) {
  const fields = response.headers.get("vary")?.toLowerCase().split(/\s*,\s*/) ?? [];
  const expected = ["accept", "purpose", "sec-purpose"];
  if (response.status !== 406) expected.push("rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch");
  for (const name of expected) {
    assert.ok(fields.includes(name), `${response.url}: Vary must contain ${name}`);
  }
}

test("HTTP: every document negotiates the exact existing Markdown representation", options, async () => {
  for (const { slug } of getAllDocs()) {
    const html = await fetchPage(`/${slug}`, "text/html");
    assert.equal(html.status, 200, slug);
    assert.match(html.headers.get("content-type") ?? "", /^text\/html\b/, slug);
    assertVary(html);
    assert.match(await html.text(), /<!DOCTYPE html>/i, slug);
    const direct = await fetchPage(`/${slug}/index.md`, "text/html");
    const negotiated = await fetchPage(`/${slug}?source=agent&value=a%2Fb`, "text/markdown", { redirect: "manual" });
    assert.equal(direct.status, 200, slug);
    assert.equal(negotiated.status, 200, slug);
    assert.equal(negotiated.headers.get("content-type"), "text/markdown; charset=utf-8", slug);
    assert.equal(negotiated.headers.get("location"), null, slug);
    assert.equal(negotiated.headers.get("cache-control"), direct.headers.get("cache-control"), slug);
    assertVary(negotiated);
    assert.equal(await negotiated.text(), await direct.text(), slug);
  }
});

test("HTTP: the OpenAPI download matches its source and documented representation", options, async () => {
  const download = await fetchPage("/openapi.yaml");
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/yaml; charset=utf-8");
  assert.equal(download.headers.get("content-disposition"), 'attachment; filename="openapi.yaml"');
  const source = fs.readFileSync(specPath, "utf8");
  assert.equal(await download.text(), source);
  const markdown = await fetchPage("/specification/reference/openapi");
  assert.equal(markdown.status, 200);
  assert.ok((await markdown.text()).includes(source));
});

test("HTTP: repeated requests to one URL keep HTML and Markdown variants separate", options, async () => {
  const path = "/specification/overview";
  const expected = await (await fetchPage(`${path}/index.md`)).text();
  for (let pass = 0; pass < 2; pass++) {
    for (const [accept, markdown] of [
      ["text/html", false], ["text/markdown", true], ["*/*", false],
      ["text/html, text/markdown", true], ["text/markdown;q=0.5, text/html", false],
      ["text/markdown;q=0.8, text/*;q=0.5, */*", true], ["text/markdown;q=0, */*", false],
      ["text/markdown;q=invalid, */*", false],
      ["text/html;q=0, */*", true], ["text/html;q=0, text/*", true],
      ["application/pdf, */*;q=0.1", false],
    ] as const) {
      const response = await fetchPage(path, accept);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", markdown ? /^text\/markdown\b/ : /^text\/html\b/);
      assertVary(response);
      const body = await response.text();
      if (markdown) assert.equal(body, expected);
      else assert.match(body, /<!DOCTYPE html>/i);
    }
  }
  const head = await fetchPage(path, "text/markdown", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "text/markdown; charset=utf-8");
  assertVary(head);
  assert.equal(await head.text(), "");
});

test("HTTP: redirects, explicit files and missing pages retain their behavior", options, async () => {
  for (const [path, destination] of [
    ["/", "/docs/getting-started/introduction"],
    ["/docs", "/docs/getting-started/introduction"],
    ["/specification", "/specification/overview"],
    ["/specification/reference", "/specification/reference/overview"],
    ["/docs/specification/overview", "/specification/overview"],
    ["/docs/reference/overview", "/specification/reference/overview"],
    ["/specification/overview/", "/specification/overview"],
  ]) {
    const response = await fetchPage(path, "text/markdown", { redirect: "manual" });
    assert.ok([307, 308].includes(response.status), path);
    assert.equal(new URL(response.headers.get("location")!, baseUrl).pathname, destination, path);
    await response.arrayBuffer();
    const followed = await fetchPage(path);
    assert.equal(followed.status, 200, path);
    assert.match(followed.headers.get("content-type") ?? "", /^text\/markdown\b/, path);
    await followed.arrayBuffer();
  }
  const direct = await fetchPage("/specification/overview/index.md", "text/markdown;q=0");
  assert.equal(direct.status, 200);
  assert.equal(direct.headers.get("content-type"), "text/markdown; charset=utf-8");
  await direct.arrayBuffer();
  for (const path of ["/docs/concepts/does-not-exist", "/specification/does-not-exist", "/specification/reference/does-not-exist"]) {
    for (const accept of ["text/markdown", "text/html", "application/pdf"]) {
      const response = await fetchPage(path, accept);
      assert.equal(response.status, 404, path);
      await response.arrayBuffer();
    }
  }
  for (const path of ["/openapi.yaml", "/llms.txt", "/search-index.json"]) {
    const normal = await fetchPage(path, "*/*");
    const markdown = await fetchPage(path);
    assert.equal(markdown.status, normal.status, path);
    assert.equal(markdown.headers.get("content-type"), normal.headers.get("content-type"), path);
    assert.equal(await markdown.text(), await normal.text(), path);
  }
});

test("HTTP: unsatisfiable requests return 406 without poisoning successful variants", options, async () => {
  for (const path of ["/docs/concepts/adapter", "/specification/overview", "/specification/reference/requests"]) {
    for (const accept of ["application/pdf", "application/json", "text/plain", "text/markdown;q=0", "text/html;q=0, text/markdown;q=0, */*", "text/*;q=0, */*", ""]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await fetchPage(path, accept, { method, redirect: "manual" });
        assert.equal(response.status, 406, `${path}: ${accept}`);
        assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
        assert.equal(response.headers.get("cache-control"), "no-store");
        assertVary(response);
        const body = await response.text();
        if (method === "HEAD") assert.equal(body, "");
        else assert.match(body, /Available representations: text\/html, text\/markdown/);
      }
    }
    for (const accept of ["text/html", "text/markdown"]) {
      const response = await fetchPage(path, accept);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), `${accept}; charset=utf-8`);
      await response.arrayBuffer();
    }
  }
});

test("HTTP: navigation and prefetch requests still return framework responses", options, async () => {
  const rsc = await fetchPage("/specification/overview", "text/markdown", { headers: { rsc: "1" } });
  assert.equal(rsc.status, 200);
  assert.match(rsc.headers.get("content-type") ?? "", /^text\/x-component\b/);
  assertVary(rsc);
  await rsc.arrayBuffer();
  for (const [name, value] of [["purpose", "prefetch"], ["sec-purpose", "prefetch;prerender"]]) {
    const response = await fetchPage("/specification/overview", "text/markdown", { headers: { [name]: value } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/);
    assertVary(response);
    await response.arrayBuffer();
  }
});

test("HTTP: HTML advertises a working Markdown alternate for link-aware clients", options, async () => {
  for (const path of ["/docs/concepts/adapter", "/specification/overview", "/specification/reference/requests"]) {
    const response = await fetchPage(path, "text/html");
    const html = await response.text();
    const links = html.match(/<link\b[^>]*>/g) ?? [];
    const alternate = links.find((link) => link.includes('rel="alternate"') && link.includes('type="text/markdown"'));
    assert.ok(alternate, path);
    const href = alternate.match(/\bhref="([^"]+)"/)?.[1];
    assert.ok(href, path);
    assert.equal(new URL(href, response.url).pathname, `${path}/index.md`);
  }
});
