import { DocumentPage, documentMetadata } from "@/components/docs/document-page";
import { specificationPages } from "@/lib/docs";

export const dynamicParams = false;
type Params = { params: Promise<{ page: string }> };
export function generateStaticParams() { return specificationPages.map(([page]) => ({ page })); }
export async function generateMetadata({ params }: Params) {
  return documentMetadata(`specification/${(await params).page}`);
}
export default async function Page({ params }: Params) {
  return <DocumentPage slug={`specification/${(await params).page}`} />;
}
