import { repositoryApiUrl, readStarCount } from "@/lib/github";
import { GitHubLink } from "@/components/site/github-link";

async function getStarCount(): Promise<number | null> {
  // Unauthenticated requests share a 60 per hour limit per IP, which hosting
  // build machines often exhaust. A token raises the limit to 5,000 per hour.
  const token = process.env.GITHUB_TOKEN;
  try {
    const response = await fetch(repositoryApiUrl, {
      headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    return readStarCount(await response.json());
  } catch {
    return null;
  }
}

export async function GitHubButton() {
  return <GitHubLink initialStars={await getStarCount()} />;
}
