import type { Element, Root, RootContent } from "hast";

function sourceText(node: RootContent): string {
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map(sourceText).join("") : "";
}

export default function rehypeMermaid() {
  return (tree: Root) => {
    function visit(node: Root | RootContent) {
      if (node.type === "element" && node.tagName === "pre") {
        const code = node.children[0] as Element | undefined;
        if (code?.type === "element" && code.tagName === "code" &&
          Array.isArray(code.properties.className) && code.properties.className.includes("language-mermaid")) {
          node.tagName = "mermaid-diagram";
          node.properties = { chart: sourceText(code).trim() };
          node.children = [];
          return;
        }
      }
      if ("children" in node) node.children.forEach(visit);
    }
    visit(tree);
  };
}
