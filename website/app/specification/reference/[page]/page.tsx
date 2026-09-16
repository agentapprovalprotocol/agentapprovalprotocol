import { DocumentPage, documentMetadata } from "@/components/docs/document-page";
import { getAllDocs } from "@/lib/docs";

export const dynamicParams = false;
type Params = { params: Promise<{ page: string }> };
export function generateStaticParams() { return getAllDocs("specification").filter((doc) => doc.section === "API reference").map((doc) => ({ page: doc.slug.split("/")[2] })); }
export async function generateMetadata({ params }: Params) {
  return documentMetadata(`specification/reference/${(await params).page}`);
}
export default async function Page({ params }: Params) {
  return <DocumentPage slug={`specification/reference/${(await params).page}`} />;
}
