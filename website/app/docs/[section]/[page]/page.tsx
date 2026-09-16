import { DocumentPage, documentMetadata } from "@/components/docs/document-page";
import { getAllDocs } from "@/lib/docs";

export const dynamicParams = false;
type Params = { params: Promise<{ section: string; page: string }> };
export function generateStaticParams() { return getAllDocs("docs").map((doc) => { const [, section, page] = doc.slug.split("/"); return { section, page }; }); }
export async function generateMetadata({ params }: Params) {
  const { section, page } = await params;
  return documentMetadata(`docs/${section}/${page}`);
}
export default async function Page({ params }: Params) {
  const { section, page } = await params;
  return <DocumentPage slug={`docs/${section}/${page}`} />;
}
