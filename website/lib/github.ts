import { site } from "@/site.config";

export const repositoryApiUrl = `https://api.github.com/repos${new URL(site.repository).pathname}`;

/** Reads the star count from a GitHub repository API response, or null when it is missing or invalid. */
export function readStarCount(repository: unknown): number | null {
  const stars = (repository as { stargazers_count?: unknown } | null)?.stargazers_count;
  return typeof stars === "number" && Number.isSafeInteger(stars) && stars >= 0 ? stars : null;
}
