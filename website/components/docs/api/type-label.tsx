import Link from "next/link";
import type { TypePart } from "@/lib/openapi";

/* Renders a type label, linking named schemas to their section on the
 * Schemas page. */
export function TypeLabel({ parts }: { parts: TypePart[] }) {
  return (
    <>
      {parts.map((part, i) =>
        part.ref ? (
          <Link
            key={i}
            href={`/specification/reference/schemas#${part.ref}`}
            className="docs-api-type-ref"
          >
            {part.text}
          </Link>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}
