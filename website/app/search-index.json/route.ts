import { getAllDocs, getDoc, markdownFor } from "@/lib/docs";
export const dynamic = "force-static";
export function GET() { return Response.json(getAllDocs().map((doc) => ({ ...doc, text: markdownFor(getDoc(doc.slug)!) }))); }
