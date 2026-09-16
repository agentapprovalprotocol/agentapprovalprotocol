import { getAllDocs, getDoc, markdownFor } from "@/lib/docs";
export const dynamic = "force-static";
export const dynamicParams = false;
export function generateStaticParams() { return getAllDocs().map((doc) => { const [section, page] = doc.slug.split("/"); return { section, page }; }); }
export async function GET(_request: Request, { params }: { params: Promise<{ section: string; page: string }> }) {
  const { section, page } = await params;
  const doc = getDoc(`${section}/${page}`);
  return new Response(doc ? markdownFor(doc) : "Not found", { status: doc ? 200 : 404, headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
