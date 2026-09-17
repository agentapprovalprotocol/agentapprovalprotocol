import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { getAllDocs } from "../lib/docs";
import { isDocumentPath } from "../lib/doc-pages";
import { config, proxy } from "../proxy";
import { unstable_doesMiddlewareMatch as doesProxyMatch } from "next/experimental/testing/server";

const origin = "https://agentapprovalprotocol.io";
function request(path: string, headers: HeadersInit = { accept: "text/markdown" }, method = "GET") {
  return new NextRequest(`${origin}${path}`, { headers, method });
}

test("every published document rewrites to its existing Markdown endpoint", () => {
  for (const { slug } of getAllDocs()) {
    assert.equal(isDocumentPath(`/${slug}`), true, slug);
    assert.equal(doesProxyMatch({ config, url: `${origin}/${slug}` }), true, slug);
    for (const method of ["GET", "HEAD"]) {
      const response = proxy(request(`/${slug}?source=agent&value=a%2Fb`, undefined, method));
      assert.equal(response.headers.get("x-middleware-rewrite"), `${origin}/${slug}/index.md?source=agent&value=a%2Fb`);
      assert.equal(response.headers.has("location"), false);
      assert.equal(response.headers.get("vary"), "Accept, Purpose, Sec-Purpose");
    }
  }
});

test("HTML responses vary by the same request headers as Markdown", () => {
  for (const accept of ["text/html", "*/*", "text/markdown;q=0, */*", "text/markdown;q=0.5, text/html"]) {
    const response = proxy(request("/specification/overview", { accept }));
    assert.equal(response.headers.get("x-middleware-next"), "1");
    assert.equal(response.headers.get("vary"), "Accept, Purpose, Sec-Purpose");
  }
});

test("index and legacy redirects, file endpoints and unrelated routes pass through", () => {
  for (const path of ["/", "/docs", "/specification", "/specification/reference", "/docs/specification/overview", "/docs/reference/requests", "/openapi.yaml", "/llms.txt", "/search-index.json", "/_next/static/chunk.js", "/docs/concepts/adapter/index.md", "/specification/overview/index.md", "/specification/reference/requests/index.md", "/docs/no-page", "/specification/too/many/segments"]) {
    const response = proxy(request(path));
    assert.equal(response.headers.get("x-middleware-next"), "1", path);
    assert.equal(response.headers.has("vary"), false, path);
  }
  for (const path of ["/", "/openapi.yaml", "/llms.txt", "/_next/static/chunk.js"]) {
    assert.equal(doesProxyMatch({ config, url: origin + path }), false, path);
  }
});

test("unsatisfiable requests return an uncached 406 with available formats and an empty HEAD body", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = proxy(request("/specification/overview", { accept: "application/pdf" }, method));
    assert.equal(response.status, 406);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(response.headers.get("vary"), "Accept, Purpose, Sec-Purpose");
    const body = await response.text();
    if (method === "HEAD") assert.equal(body, "");
    else assert.match(body, /Available representations: text\/html, text\/markdown/);
  }
});

test("unknown document paths remain 404 candidates even when Accept cannot be satisfied", () => {
  for (const path of ["/docs/concepts/missing", "/specification/missing", "/specification/reference/missing"]) {
    assert.equal(isDocumentPath(path), false);
    for (const accept of ["application/pdf", "text/markdown", "text/html"]) {
      assert.equal(proxy(request(path, { accept })).headers.get("x-middleware-next"), "1", path);
    }
  }
});

test("unsupported methods and framework navigation requests are never rewritten", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.equal(proxy(request("/specification/overview", undefined, method)).headers.get("x-middleware-next"), "1");
  }
  for (const [name, value] of [
    ["rsc", "1"], ["next-router-state-tree", "[]"], ["next-router-prefetch", "1"],
    ["next-router-segment-prefetch", "/_tree"], ["purpose", "prefetch"], ["sec-purpose", "prefetch;prerender"],
  ]) {
    const response = proxy(request("/specification/overview", { accept: "text/markdown", [name]: value }));
    assert.equal(response.headers.get("x-middleware-next"), "1");
    assert.equal(response.headers.get("vary"), "Accept, Purpose, Sec-Purpose");
  }
});
