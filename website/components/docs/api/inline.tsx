import { Fragment } from "react";

/* Renders the inline code spans of a spec description. OpenAPI descriptions
 * are CommonMark, and the reference uses one construct from it: backticks
 * around a field, header, or value. Everything else stays plain text. */
export function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]*`)/);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
          <code key={i}>{part.slice(1, -1)}</code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
