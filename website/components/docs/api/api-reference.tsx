import { HighlightedCode } from "../code-block";
import { SchemaTable } from "./schema-table";
import { SchemaDetails } from "./schema-details";
import { MethodPill } from "./method-pill";
import { AnchorIcon } from "./anchor-icon";
import { Inline } from "./inline";
import { Description } from "./description";
import { TypeLabel } from "./type-label";
import { typeParts, type ApiGroup, type ApiSchema } from "@/lib/openapi";

export function ApiReference({ group }: { group: ApiGroup }) {
  return group.operations.map((op) => <section key={op.id} className="docs-api-op">
    <h2 id={op.id}>{op.summary}<a href={`#${op.id}`} className="docs-api-anchor" aria-label={`Link to ${op.summary}`}><AnchorIcon /></a></h2>
    <div className="docs-api-endpoint"><MethodPill method={op.method} /><code className="docs-api-path">{op.path}</code></div>
    {op.webhook && <p className="docs-api-note">Sent by the provider to the receiver configured on the instance.</p>}
    {op.description.split(/\n\s*\n/).map((paragraph, i) => <p key={i}><Inline text={paragraph} /></p>)}
    <div className="api-auth">
      <span className="docs-api-label">Authentication</span>
      {op.auth.length ? op.auth.map((alternative, index) => <div key={index}>
        {index > 0 && <p>Or</p>}
        {alternative.length ? alternative.map((scheme) => <p key={scheme.name}><strong>{scheme.name}</strong><br /><Inline text={scheme.description} /></p>) : <p>No authentication required.</p>}
      </div>) : <p>No authentication required.</p>}
    </div>
    {!!op.parameters.length && <><h3 id={`${op.id}-parameters`}>Parameters</h3><SchemaTable rows={op.parameters} anchorPrefix={`${op.id}-parameter`} /></>}
    {op.requestBody && <>
      <h3 id={`${op.id}-request`}>Request body</h3>
      <p><code>{op.requestBody.contentType}</code>{op.requestBody.required ? " · required" : " · optional"}</p>
      {op.requestBody.schema && <SchemaDetails schema={op.requestBody.schema} id={`${op.id}-body`} />}
      {op.requestBody.examples.map((example) => <HighlightedCode key={example.name} title={example.summary ?? example.name} code={JSON.stringify(example.value, null, 2)} lang="json" />)}
    </>}
    <h3 id={`${op.id}-responses`}>Responses</h3>
    <div className="blog-table-wrap"><table className="docs-api-table"><thead><tr><th>Status</th><th>Meaning</th><th>Body</th></tr></thead><tbody>
      {op.responses.map((response) => <tr key={response.status}><td><code>{response.status}</code></td><td><Description text={response.description} /></td><td><TypeLabel parts={response.schema ? typeParts(response.schema) : [{ text: "No body" }]} /></td></tr>)}
    </tbody></table></div>
    {op.responses.filter((response) => Number(response.status) < 300).map((response) => <div key={response.status} className="api-response">
      <h4>{response.status} response</h4>
      {!!response.headers.length && <SchemaTable rows={response.headers} nameHeading="Header" anchorPrefix={`${op.id}-${response.status}-header`} />}
      {response.schema && <SchemaDetails schema={response.schema} id={`${op.id}-${response.status}-response`} />}
      {response.examples.map((example) => <HighlightedCode key={example.name} title={example.summary ?? example.name} code={JSON.stringify(example.value, null, 2)} lang="json" />)}
    </div>)}
    {op.responses.some((response) => Number(response.status) >= 300 && response.headers.length) && <details className="schema-source">
      <summary>Error and retry response headers</summary>
      {op.responses.filter((response) => Number(response.status) >= 300 && response.headers.length).map((response) => <div key={response.status}>
        <h4>{response.status}</h4><SchemaTable rows={response.headers} nameHeading="Header" anchorPrefix={`${op.id}-${response.status}-header`} />
      </div>)}
    </details>}
  </section>);
}

export function SchemaReference({ schemas }: { schemas: ApiSchema[] }) {
  return schemas.map(({ name, schema }) => <section key={name} className="docs-api-op">
    <h2 id={name}><code className="docs-api-schema-name">{name}</code><a href={`#${name}`} className="docs-api-anchor" aria-label={`Link to ${name}`}><AnchorIcon /></a></h2>
    <SchemaDetails schema={schema} id={name} />
  </section>);
}
