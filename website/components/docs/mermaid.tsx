"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTheme } from "@/components/site/theme-provider";
import { labelSequenceAlternatives, positionFlowchartLabels } from "@/lib/mermaid-labels";
import { CodeFrame } from "./code-frame";

let rendering: Promise<unknown> = Promise.resolve();
let renderCount = 0;

export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const { resolvedTheme } = useTheme();
  const canvas = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    rendering = rendering.catch(() => {}).then(async () => {
      const { default: mermaid } = await import("mermaid");
      if (!active) return;
      mermaid.initialize({
        startOnLoad: false, securityLevel: "strict",
        theme: resolvedTheme === "dark" ? "dark" : "neutral",
        fontFamily: "Inter, system-ui, sans-serif",
        themeCSS: ".edgeLabel rect { fill: none; }",
        sequence: { useMaxWidth: true, wrap: true },
        flowchart: { htmlLabels: false, rankSpacing: 90, nodeSpacing: 80 },
      });
      const rendered = await mermaid.render(`diagram-${id}-${++renderCount}`, chart);
      if (active) { setSvg(rendered.svg); setFailed(false); }
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [chart, id, resolvedTheme]);

  useLayoutEffect(() => {
    const diagram = canvas.current?.querySelector<SVGSVGElement>("svg");
    if (!diagram) return;
    labelSequenceAlternatives(diagram);
    if (diagram.classList.contains("flowchart")) positionFlowchartLabels(diagram);
  }, [svg]);

  return (
    <figure className="mermaid-diagram" aria-label="Protocol diagram">
      {svg && !failed ? <div ref={canvas} className="mermaid-canvas" dangerouslySetInnerHTML={{ __html: svg }} /> :
        <p role="status">{failed ? "The diagram could not be displayed. Its source is available below." : "Loading diagram…"}</p>}
      <details className="mermaid-source">
        <summary>Diagram source</summary>
        <CodeFrame lang="mermaid">
          <pre><code>{chart}</code></pre>
        </CodeFrame>
      </details>
    </figure>
  );
}
