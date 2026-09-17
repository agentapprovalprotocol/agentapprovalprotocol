import { site } from "@/site.config";
import { externalLinkProps } from "@/lib/links";

async function getStarCount(): Promise<number | null> {
  try {
    const response = await fetch(`https://api.github.com/repos${new URL(site.repository).pathname}`, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const repository = await response.json();
    const stars = repository?.stargazers_count;
    return typeof stars === "number" && Number.isSafeInteger(stars) && stars >= 0 ? stars : null;
  } catch {
    return null;
  }
}

export async function GitHubButton() {
  const stars = await getStarCount();
  const label = stars === null
    ? "Star on GitHub"
    : `View on GitHub, ${stars.toLocaleString("en-US")} ${stars === 1 ? "star" : "stars"}`;
  const count = stars === null ? "Star" : new Intl.NumberFormat("en-US", {
    notation: "compact", maximumFractionDigits: 1,
  }).format(stars);

  return <a href={site.repository} {...externalLinkProps(site.repository)} className="docs-github" aria-label={label} title={label}>
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="docs-github-mark">
      <path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.09c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.98 0 0 .94-.3 3.09 1.15A10.77 10.77 0 0 1 12 6.17c.96 0 1.92.13 2.82.38 2.15-1.46 3.09-1.15 3.09-1.15.61 1.55.23 2.7.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.32-2.64 5.28-5.15 5.56.4.35.76 1.03.76 2.08v3.09c0 .3.2.65.78.54A11.25 11.25 0 0 0 12 .75Z" />
    </svg>
    <span className="docs-github-label">GitHub</span>
    <span className="docs-github-stars" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none"><path d="m8 1.5 2 4.1 4.5.7-3.25 3.2.75 4.5L8 11.9 4 14l.75-4.5L1.5 6.3 6 5.6 8 1.5Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" /></svg>
      {count}
    </span>
  </a>;
}
