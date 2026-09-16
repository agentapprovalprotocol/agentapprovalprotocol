import { HighlightedCode } from "../code-block";
import { FieldList } from "./field-list";
import { TypeLabel } from "./type-label";
import { Inline } from "./inline";
import { resolve, schemaFields, schemaRules, typeParts, type Schema } from "@/lib/openapi";

export function SchemaDetails({ schema, id }: { schema: Schema; id: string }) {
  const resolved = resolve(schema);
  const source = Object.fromEntries(Object.entries(resolved).filter(([key]) => key !== "$name"));
  const fields = schemaFields(schema);
  const variants = resolved.oneOf ?? resolved.anyOf;
  return <>
    {resolved.description && <p><Inline text={resolved.description} /></p>}
    {fields.length ? <FieldList fields={fields} anchorPrefix={id} /> : <p><TypeLabel parts={typeParts(resolved)} /></p>}
    {variants && <div className="schema-variants">
      <p>{resolved.oneOf ? "Exactly one of these variants must match:" : "At least one of these variants must match:"}</p>
      {variants.map((variant, index) => <div key={index} className="schema-variant">
        <strong>{variant.title ?? `Variant ${index + 1}`}</strong>
        <ul>{schemaRules(variant).map((rule) => <li key={rule}>{rule}</li>)}</ul>
      </div>)}
    </div>}
    <details className="schema-source">
      <summary>View complete schema and constraints</summary>
      <HighlightedCode code={JSON.stringify(source, null, 2)} lang="json" />
    </details>
  </>;
}
