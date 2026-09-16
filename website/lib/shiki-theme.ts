import type { ThemeRegistration } from "shiki";

/* Paired code themes for docs fences. Shiki writes colors inline, so these
 * are the palette hexes from app/globals.css rather than tokens: ink for
 * plain text, faint comments, accent keywords, green strings, a warm tone
 * for numbers, types and attributes. Light draws from the light tokens
 * (ocean-blue, fern-green, chocolate-brown); dark from the dark block, with
 * the keyword blue lifted above the dark accent for contrast on surface.
 * Keep both in step with the @theme block and its dark override. */

interface CodePalette {
  ink: string;
  inkSoft: string;
  inkMuted: string;
  inkFaint: string;
  keyword: string;
  string: string;
  constant: string;
}

const light: CodePalette = {
  ink: "#0a0d17",
  inkSoft: "#1e1f22",
  inkMuted: "#626366",
  inkFaint: "#808083",
  keyword: "#0347fa",
  string: "#3d7e5d",
  constant: "#521604",
};

const dark: CodePalette = {
  ink: "#f2f3f6",
  inkSoft: "#d7dae0",
  inkMuted: "#9aa1ad",
  inkFaint: "#6f7683",
  keyword: "#8fa8ff",
  string: "#74d69c",
  constant: "#e0b48a",
};

function theme(
  name: string,
  displayName: string,
  type: "light" | "dark",
  bg: string,
  {
    ink,
    inkSoft,
    inkMuted,
    inkFaint,
    keyword: blue,
    string: green,
    constant: brown,
  }: CodePalette,
): ThemeRegistration {
  return {
    name,
    displayName,
    type,
    fg: inkSoft,
    bg,
    settings: [
      { settings: { foreground: inkSoft } },
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: inkFaint },
      },
      {
        scope: [
          "keyword",
          "storage",
          "storage.type",
          "keyword.operator.new",
          "keyword.operator.expression",
          "variable.language",
          "entity.name.tag",
          "support.function.builtin.shell",
        ],
        settings: { foreground: blue },
      },
      {
        scope: [
          "string",
          "string.quoted",
          "punctuation.definition.string",
          "string.unquoted.argument.shell",
        ],
        settings: { foreground: green },
      },
      {
        scope: [
          "constant.numeric",
          "constant.language",
          "support.constant",
          "constant.other.option",
          "entity.name.type",
          "entity.name.class",
          "support.type",
          "support.class",
          "entity.other.attribute-name",
        ],
        settings: { foreground: brown },
      },
      {
        scope: [
          "entity.name.function",
          "support.function",
          "meta.function-call entity.name.function",
          "entity.name.command",
        ],
        settings: { foreground: ink },
      },
      {
        scope: [
          "variable.parameter",
          "variable.other.property",
          "support.type.property-name",
          "meta.object-literal.key",
          "keyword.key.toml",
          "entity.name.tag.toml",
        ],
        settings: { foreground: inkSoft },
      },
      {
        scope: ["punctuation", "meta.brace", "keyword.operator"],
        settings: { foreground: inkMuted },
      },
    ],
  };
}

export const aapLight = theme(
  "aap-light",
  "AAP light",
  "light",
  "#ffffff",
  light,
);

export const aapDark = theme(
  "aap-dark",
  "AAP dark",
  "dark",
  "#12151d",
  dark,
);
