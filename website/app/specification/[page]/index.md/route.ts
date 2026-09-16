import { specificationPages } from "@/lib/docs";
import { markdownResponse } from "@/lib/markdown-response";

export const dynamic = "force-static";
export const dynamicParams = false;
export function generateStaticParams() { return specificationPages.map(([page]) => ({ page })); }
export async function GET(_request: Request, { params }: { params: Promise<{ page: string }> }) {
  return markdownResponse(`specification/${(await params).page}`);
}
