import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHmac } from "node:crypto";
import { getAllDocs, getDoc, markdownFor, resolveDocLink } from "../lib/docs";
import { getApiGroups, getApiSchemas, getSpec, repositoryRoot, resolve, schemaFields, schemaRules } from "../lib/openapi";
import { extractHeadings } from "../lib/content";

test("reference publishes every API operation and both provider-to-receiver webhooks", () => {
  const operations = getApiGroups().flatMap((group) => group.operations);
  const source = getSpec();
  const count = (items: Record<string, object>) => Object.values(items).reduce((sum, item) => sum + ["get", "post", "put", "patch", "delete"].filter((method) => method in item).length, 0);
  assert.equal(operations.length, count(source.paths) + count(source.webhooks ?? {}));
  assert.equal(operations.filter((op) => op.webhook).length, 2);
  assert.equal(operations.find((op) => op.id === "createApprovalRequest")?.auth[0][0].name, "Instance Credential");
  for (const op of operations.filter((entry) => entry.webhook)) assert.equal(op.auth[0][0].name, "Webhook Signature");
  assert.ok(operations.find((op) => op.path === "/v1/instances" && op.method === "POST")?.auth[0][0].name.includes("Provisioner"));
});

test("examples, required headers, conditional approvals and boolean exclusions survive rendering", () => {
  const op = getApiGroups().flatMap((group) => group.operations).find((op) => op.id === "createApprovalRequest")!;
  assert.equal(op.requestBody?.examples[0].value && (op.requestBody.examples[0].value as { tool: string }).tool, "issue_refund");
  assert.ok(op.responses.find((response) => response.status === "201")?.headers.some((header) => header.name === "X-Request-ID" && header.required));
  const decision = getSpec().components.schemas.Decision;
  const fields = schemaFields(decision);
  assert.equal(fields.find((field) => field.name === "expires_at")?.required, false);
  assert.equal(fields.find((field) => field.name === "expires_at")?.conditional, true);
  assert.ok(schemaRules(decision.oneOf![1]).includes("expires_at must be absent."));
  assert.equal(resolve({ $ref: "#/components/schemas/Identifier", description: "Specific description" }).description, "Specific description");
  assert.ok(getApiSchemas().some((schema) => schema.name === "WebhookVerification"));
});

test("all authored relative links and fragments map to real pages or the schema", () => {
  for (const meta of getAllDocs()) {
    const doc = getDoc(meta.slug)!;
    assert.ok(markdownFor(doc).startsWith("# "));
    if (doc.kind !== "markdown") continue;
    for (const [, href] of doc.content.matchAll(/\]\(([^)]+)\)/g)) {
      const resolved = resolveDocLink(href);
      if (!resolved.startsWith("/docs/")) continue;
      const [slug, fragment] = resolved.slice("/docs/".length).split("#");
      const target = getDoc(slug);
      assert.ok(target, `${meta.slug}: missing ${resolved}`);
      if (fragment) assert.ok(target.toc.some((heading) => heading.id === fragment), `${meta.slug}: missing anchor ${resolved}`);
    }
  }
});

test("documented webhook signature verifies against the exact example body", () => {
  const source = fs.readFileSync(path.join(repositoryRoot, "docs/specification/7_async.md"), "utf8");
  const secret = source.match(/"signing_secret": "whsec_([^"]+)"/)![1];
  const block = [...source.matchAll(/```http\n([\s\S]*?)\n```/g)].map((match) => match[1]).find((value) => value.includes("webhook-signature:"))!;
  const [headers, body] = block.split(/\n\n/);
  const header = (name: string) => headers.match(new RegExp(`^${name}: (.+)$`, "m"))![1];
  const signature = createHmac("sha256", Buffer.from(secret, "base64")).update(`${header("webhook-id")}.${header("webhook-timestamp")}.${body}`).digest("base64");
  assert.equal(header("webhook-signature"), `v1,${signature}`);
  assert.equal(JSON.parse(body).id, header("webhook-id"));
});

test("headings inside HTTP examples and diagrams do not become page anchors", () => {
  assert.deepEqual(extractHeadings("## Flow\n```http\n## not a heading\n```\n### Example"), [{ id: "flow", title: "Flow", level: 2 }, { id: "example", title: "Example", level: 3 }]);
});
