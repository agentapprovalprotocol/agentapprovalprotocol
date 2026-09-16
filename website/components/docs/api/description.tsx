import { Inline } from "./inline";

export function Description({ text, className = "" }: { text: string; className?: string }) {
  return <div className={`docs-api-description ${className}`.trim()}>
    {text.trim().split(/\r?\n\s*\r?\n/).map((paragraph, index) => (
      <p key={index}><Inline text={paragraph} /></p>
    ))}
  </div>;
}
