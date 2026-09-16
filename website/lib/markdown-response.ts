import { getDoc, markdownFor } from "./docs";

export function markdownResponse(slug: string) {
  const doc = getDoc(slug);
  return new Response(doc ? markdownFor(doc) : "Not found", { status: doc ? 200 : 404, headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
