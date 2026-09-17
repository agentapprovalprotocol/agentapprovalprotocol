import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import sitemap from "../app/sitemap";
import apiPageMetadata from "../api-page-metadata.json";
import { getAllDocs, getDoc, markdownFor } from "../lib/docs";
import { repositoryRoot } from "../lib/openapi";
import { parseMarkdownPage, validateLastModified } from "../lib/page-metadata";
import { site } from "../site.config";

test("Markdown metadata preserves the authored date and separates it from content", () => {
  for (const newline of ["\n", "\r\n"]) {
    const body = ["", "# Title", "", "Content.", "", "---", "", "More content."].join(newline);
    const markdown = ["---", "lastModified: 2024-02-29", "---", body].join(newline);
    assert.deepEqual(parseMarkdownPage(markdown, "example.md"), { lastModified: "2024-02-29", content: body });
    assert.equal(parseMarkdownPage(markdown.replace("Content.", "Updated content."), "example.md").lastModified, "2024-02-29");
  }
});

test("missing metadata and invalid calendar dates fail with the source name", () => {
  for (const value of [undefined, null, 20260917, "", "2026-9-17", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-09-17T00:00:00Z"]) {
    assert.throws(() => validateLastModified(value, "example.md"), /lastModified in example\.md/);
  }
  for (const markdown of ["# No metadata", "---\nlastModified: 2026-09-17\n# Unclosed metadata", "---\ntitle: Missing date\n---\n# Title", "---\nnull\n---\n# Title", "---\nlastModified: [\n---\n# Title"]) {
    assert.throws(() => parseMarkdownPage(markdown, "example.md"), /example\.md/);
  }
});

test("the sitemap includes the explicit metadata date for every canonical page", () => {
  const pages = getAllDocs();
  const entries = sitemap();
  assert.equal(entries.length, pages.length);
  assert.equal(new Set(entries.map((entry) => entry.url)).size, pages.length);
  const generatedSlugs: string[] = [];
  for (const page of pages) {
    const doc = getDoc(page.slug)!;
    let expected: string;
    if (doc.kind === "markdown") {
      const source = fs.readFileSync(path.join(repositoryRoot, doc.source), "utf8");
      expected = source.match(/^lastModified: (\d{4}-\d{2}-\d{2})$/m)![1];
      assert.ok(!doc.content.includes("lastModified:"));
      assert.ok(!markdownFor(doc).includes("lastModified:"));
      assert.equal([...markdownFor(doc).matchAll(/^# /gm)].length, 1);
    } else {
      generatedSlugs.push(page.slug);
      expected = (apiPageMetadata as Record<string, { lastModified: string }>)[page.slug].lastModified;
    }
    assert.equal(entries.find((entry) => entry.url === `${site.url}/${page.slug}`)?.lastModified, expected, page.slug);
  }
  assert.deepEqual(Object.keys(apiPageMetadata).sort(), generatedSlugs.sort());
  assert.deepEqual(sitemap(), entries);
});
