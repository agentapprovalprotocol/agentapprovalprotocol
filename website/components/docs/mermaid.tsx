"use client";

import { useEffect, useId, useState } from "react";
import { useTheme } from "@/components/site/theme-provider";

let rendering: Promise<unknown> = Promise.resolve();
let renderCount = 0;

export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const { resolvedTheme } = useTheme();
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
        sequence: { useMaxWidth: true, wrap: true },
        flowchart: { htmlLabels: false },
      });
      const rendered = await mermaid.render(`diagram-${id}-${++renderCount}`, chart);
      if (active) { setSvg(rendered.svg); setFailed(false); }
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [chart, id, resolvedTheme]);

  return (
    <figure className="mermaid-diagram" aria-label="Protocol diagram">
      {svg && !failed ? <div className="mermaid-canvas" dangerouslySetInnerHTML={{ __html: svg }} /> :
        <p role="status">{failed ? "The diagram could not be displayed. Its source is available below." : "Loading diagram…"}</p>}
      <details className="mermaid-source">
        <summary>Diagram source</summary>
        <pre><code>{chart}</code></pre>
      </details>
    </figure>
  );
}
