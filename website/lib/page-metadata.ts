import { parse } from "yaml";

export function validateLastModified(value: unknown, source: string): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value) return value;
  }
  throw new Error(`Invalid or missing lastModified in ${source}: expected a calendar date in YYYY-MM-DD format.`);
}

export function parseMarkdownPage(markdown: string, source: string): { lastModified: string; content: string } {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error(`Missing YAML frontmatter in ${source}: add lastModified in YYYY-MM-DD format.`);
  let metadata: unknown;
  try {
    metadata = parse(frontmatter[1]);
  } catch (cause) {
    throw new Error(`Invalid YAML frontmatter in ${source}.`, { cause });
  }
  const lastModified = metadata && typeof metadata === "object" && "lastModified" in metadata ? metadata.lastModified : undefined;
  return { lastModified: validateLastModified(lastModified, source), content: markdown.slice(frontmatter[0].length) };
}
