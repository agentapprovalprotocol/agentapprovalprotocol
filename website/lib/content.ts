import GithubSlugger from "github-slugger";

export interface TocItem {
  id: string;
  title: string;
  level: 2 | 3;
  code?: boolean;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
}

export function extractHeadings(content: string): TocItem[] {
  const slugger = new GithubSlugger();
  return content.replace(/```[\s\S]*?```/g, "").split("\n").flatMap((line) => {
    const match = line.match(/^(#{2,3})\s+(.*)$/);
    if (!match) return [];
    const title = match[2].replace(/[*_`]/g, "").trim();
    return [{ id: slugger.slug(title), title, level: match[1].length as 2 | 3 }];
  });
}
