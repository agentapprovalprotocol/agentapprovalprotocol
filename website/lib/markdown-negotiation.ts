export const markdownVary = "Accept, Purpose, Sec-Purpose";

// Split header lists without treating separators inside quoted parameters as entries.
function splitHeader(value: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    if (quoted && value[i] === "\\") {
      i++;
    } else if (value[i] === '"') {
      quoted = !quoted;
    } else if (!quoted && value[i] === separator) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  if (!quoted) parts.push(value.slice(start));
  return parts;
}

function quality(parameters: string[]): number {
  const weights = parameters.map((parameter) => parameter.trim().split(/\s*=\s*/))
    .filter(([name]) => name.toLowerCase() === "q");
  if (!weights.length) return 1;
  if (weights.length !== 1 || weights[0].length !== 2) return 0;
  const value = weights[0][1];
  return /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0;
}

type Preference = { quality: number; specificity: number };
export type DocumentFormat = "html" | "markdown";

// Both representations are UTF-8 and have no other media-type parameters.
function charsetSpecificity(parameters: string[]): number | null {
  let specificity = 0;
  for (const parameter of parameters) {
    if (!parameter.trim() || /^q(?:\s*=|\s*$)/i.test(parameter.trim())) continue;
    if (!/^charset\s*=\s*(?:utf-8|"utf-8")$/i.test(parameter.trim()) || specificity) return null;
    specificity = 1;
  }
  return specificity;
}

export function negotiateDocument(accept: string | null): DocumentFormat | null {
  if (accept === null) return "html";
  const preferences: Record<DocumentFormat, Preference> = {
    html: { quality: 0, specificity: -1 },
    markdown: { quality: 0, specificity: -1 },
  };

  for (const entry of splitHeader(accept, ",")) {
    const [mediaType, ...parameters] = splitHeader(entry, ";");
    const type = mediaType?.trim().toLowerCase();
    const weight = quality(parameters);
    const charset = charsetSpecificity(parameters);
    if (charset === null) continue;

    for (const format of ["html", "markdown"] as const) {
      const match = type === `text/${format}` ? 2 : type === "text/*" ? 1 : type === "*/*" ? 0 : -1;
      if (match < 0) continue;
      const specificity = match * 2 + charset;
      const previous = preferences[format];
      // An exact rejection overrides a wildcard, regardless of its weight.
      if (specificity > previous.specificity || (specificity === previous.specificity && weight > previous.quality)) {
        preferences[format] = { quality: weight, specificity };
      }
    }
  }

  const { html, markdown } = preferences;
  if (html.quality === 0 && markdown.quality === 0) return null;
  if (markdown.quality > html.quality) return "markdown";
  // Explicit Markdown wins equal-weight ties; unrestricted wildcards default to HTML.
  if (markdown.quality === html.quality && markdown.specificity >= 4) return "markdown";
  return "html";
}
