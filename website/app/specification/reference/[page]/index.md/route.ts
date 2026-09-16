import { getAllDocs } from "@/lib/docs";
import { markdownResponse } from "@/lib/markdown-response";

export const dynamic = "force-static";
export const dynamicParams = false;
export function generateStaticParams() { return getAllDocs("specification").filter((doc) => doc.section === "API reference").map((doc) => ({ page: doc.slug.split("/")[2] })); }
export async function GET(_request: Request, { params }: { params: Promise<{ page: string }> }) {
  return markdownResponse(`specification/reference/${(await params).page}`);
}
