import type { MetadataRoute } from "next";
import { getAllDocs } from "@/lib/docs";
import { site } from "@/site.config";
export default function sitemap(): MetadataRoute.Sitemap { return [{ url: site.url }, ...getAllDocs().map((doc) => ({ url: `${site.url}/docs/${doc.slug}` }))]; }
