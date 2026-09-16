"use client";

import * as React from "react";
import type { SchemaField } from "@/lib/openapi";
import { AnchorIcon } from "./anchor-icon";
import { Inline } from "./inline";
import { TypeLabel } from "./type-label";

/* Body fields as a list: name, type, required marker, description. Fields
 * that are objects (or arrays of objects) get a toggle that opens their child
 * attributes in a framed sub-list, nesting as deep as the schema goes.
 *
 * Every field is an anchor (`<operationId>-<body|response>-<path>`): the name
 * links to it, and arriving on a deep link opens the parents and scrolls to
 * the field once it has rendered. */
export function FieldList({
  fields,
  anchorPrefix,
}: {
  fields: SchemaField[];
  anchorPrefix: string;
}) {
  return (
    <div className="docs-api-fields">
      {fields.map((field) => (
        <Field key={field.name} field={field} prefix={anchorPrefix} />
      ))}
    </div>
  );
}

function currentHash(): string {
  return decodeURIComponent(window.location.hash.slice(1));
}

function Field({ field, prefix }: { field: SchemaField; prefix: string }) {
  const id = `${prefix}-${field.name}`;
  const [open, setOpen] = React.useState(false);
  const [targeted, setTargeted] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const count = field.children.length;

  React.useEffect(() => {
    const sync = () => {
      const hash = currentHash();
      if (hash.startsWith(`${id}-`)) setOpen(true);
      const isTarget = hash === id;
      setTargeted(isTarget);
      if (isTarget) ref.current?.scrollIntoView({ block: "start" });
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [id]);

  return (
    <div
      ref={ref}
      id={id}
      data-targeted={targeted || undefined}
      className="docs-api-field"
    >
      <div className="docs-api-field-head">
        <a href={`#${id}`} className="docs-api-field-name">
          {field.name}
          <AnchorIcon />
        </a>
        <span className="docs-api-field-type">
          <TypeLabel parts={field.type} />
        </span>
        {field.required && <span className="docs-api-required">required</span>}
        {!field.required && field.conditional && <span className="docs-api-required">conditional</span>}
      </div>
      {field.description && (
        <p className="docs-api-field-desc"><Inline text={field.description} /></p>
      )}
      {field.enumValues && (
        <p className="docs-api-field-desc docs-api-enum">
          One of{" "}
          {field.enumValues.map((value, i) => (
            <span key={value}>
              <code>{value}</code>
              {i < field.enumValues!.length - 1 ? ", " : ""}
            </span>
          ))}
        </p>
      )}
      {count > 0 && (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="docs-api-field-toggle"
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-3">
              <path
                d="M6 3.5l4.5 4.5L6 12.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {open ? "Hide" : "Show"} {count} child{" "}
            {count === 1 ? "attribute" : "attributes"}
          </button>
          {open && (
            <div className="docs-api-field-children">
              {field.children.map((child) => (
                <Field key={child.name} field={child} prefix={id} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
