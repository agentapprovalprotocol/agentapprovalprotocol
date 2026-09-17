import type { MetadataRoute } from "next";
import { getAllDocs, getDocLastModified } from "@/lib/docs";
import { site } from "@/site.config";

export default function sitemap(): MetadataRoute.Sitemap {
  return getAllDocs().map((doc) => ({ url: `${site.url}/${doc.slug}`, lastModified: getDocLastModified(doc.slug) }));
}
