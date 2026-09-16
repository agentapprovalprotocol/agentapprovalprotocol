import { getAllDocs } from "@/lib/docs";
import { markdownResponse } from "@/lib/markdown-response";
export const dynamic = "force-static";
export const dynamicParams = false;
export function generateStaticParams() { return getAllDocs("docs").map((doc) => { const [, section, page] = doc.slug.split("/"); return { section, page }; }); }
export async function GET(_request: Request, { params }: { params: Promise<{ section: string; page: string }> }) {
  const { section, page } = await params;
  return markdownResponse(`docs/${section}/${page}`);
}
