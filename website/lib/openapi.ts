import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const specPath = path.join(repositoryRoot, "openapi.yaml");

export interface Schema {
  $ref?: string;
  $name?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  format?: string;
  properties?: Record<string, Schema | boolean>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  items?: Schema;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  [key: string]: unknown;
}
interface Ref { $ref?: string }
interface Example extends Ref { summary?: string; value?: unknown }
interface Media { schema?: Schema; example?: unknown; examples?: Record<string, Example> }
interface Body extends Ref { required?: boolean; content?: Record<string, Media> }
interface Parameter extends Ref { name: string; in: string; required?: boolean; description?: string; schema?: Schema }
interface Response extends Ref { description?: string; headers?: Record<string, Omit<Parameter, "name" | "in">>; content?: Record<string, Media> }
interface SecurityScheme { type: string; scheme?: string; name?: string; in?: string; description?: string }
interface Operation { operationId: string; summary?: string; description?: string; tags?: string[]; parameters?: Parameter[]; security?: Record<string, string[]>[]; requestBody?: Body; responses: Record<string, Response> }
type PathItem = { parameters?: Parameter[] } & Partial<Record<Lowercase<ApiMethod>, Operation>>;
interface Document {
  info: { title: string; version: string; description?: string };
  tags: { name: string; description?: string }[];
  paths: Record<string, PathItem>;
  webhooks?: Record<string, PathItem>;
  security?: Record<string, string[]>[];
  components: { schemas: Record<string, Schema>; securitySchemes: Record<string, SecurityScheme>; [key: string]: unknown };
}

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface TypePart { text: string; ref?: string }
export interface SchemaRow { name: string; type: TypePart[]; required: boolean; description?: string; enumValues?: string[] }
export interface SchemaField extends SchemaRow { children: SchemaField[]; conditional?: boolean }
export interface ApiExample { name: string; summary?: string; value: unknown }
export interface ApiResponse { status: string; description: string; headers: SchemaRow[]; schema?: Schema; examples: ApiExample[] }
export interface ApiOperation {
  id: string; method: ApiMethod; path: string; webhook: boolean; summary: string; description: string;
  auth: { name: string; description: string }[][];
  parameters: SchemaRow[];
  requestBody?: { required: boolean; contentType: string; schema?: Schema; examples: ApiExample[] };
  responses: ApiResponse[];
}
export interface ApiGroup { tag: string; slug: string; title: string; description: string; operations: ApiOperation[] }
export interface ApiSchema { name: string; schema: Schema; fields: SchemaField[] }

let cached: Document | undefined;
export function getSpec(): Document {
  return cached ??= parse(fs.readFileSync(specPath, "utf8")) as Document;
}

export function resolve<T extends Ref>(input: T): T {
  if (!input.$ref) return input;
  if (!input.$ref.startsWith("#/")) throw new Error(`Only local references are supported: ${input.$ref}`);
  let target: unknown = getSpec();
  for (const segment of input.$ref.slice(2).split("/")) {
    target = (target as Record<string, unknown>)?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  if (!target) throw new Error(`Unresolved reference: ${input.$ref}`);
  const { $ref, ...overrides } = input;
  const resolved = { ...resolve(target as T), ...overrides };
  return ($ref.startsWith("#/components/schemas/") ? { ...resolved, $name: $ref.split("/").at(-1) } : resolved) as T;
}

function objectSchema(input: Schema): Schema {
  const schema = resolve(input);
  if (!schema.allOf) return schema;
  const parts = schema.allOf.map(objectSchema);
  return {
    ...Object.assign({}, ...parts), ...schema,
    properties: Object.assign({}, ...parts.map((part) => part.properties), schema.properties),
    required: [...new Set([...parts.flatMap((part) => part.required ?? []), ...(schema.required ?? [])])],
  };
}

export function typeParts(input?: Schema): TypePart[] {
  if (!input) return [{ text: "any" }];
  const schema = resolve(input);
  if (schema.$name) return [{ text: schema.$name, ref: schema.$name }];
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants) return variants.flatMap((variant, index) => [...(index ? [{ text: " | " }] : []), ...typeParts(variant)]);
  if (schema.allOf) return typeParts(schema.allOf[0]);
  if (schema.const !== undefined) return [{ text: JSON.stringify(schema.const) }];
  if (schema.type === "array") return [{ text: "array<" }, ...typeParts(schema.items), { text: ">" }];
  return [{ text: schema.format ?? (Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type) ?? "object" }];
}

export function schemaFields(input?: Schema, ancestors: Set<string> = new Set()): SchemaField[] {
  if (!input) return [];
  const resolved = resolve(input);
  if (resolved.$name && ancestors.has(resolved.$name)) return [];
  const visited = new Set(ancestors);
  if (resolved.$name) visited.add(resolved.$name);
  const schema = objectSchema(input);
  return Object.entries(schema.properties ?? {}).filter(([, value]) => value !== false).map(([name, raw]) => {
    const field = typeof raw === "boolean" ? {} : resolve(raw);
    return {
      name, type: typeParts(typeof raw === "boolean" ? {} : raw),
      required: schema.required?.includes(name) ?? false,
      conditional: [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].some((variant) => variant.required?.includes(name)),
      description: field.description,
      enumValues: field.enum?.map(String),
      children: schemaFields(field.type === "array" ? field.items : typeof raw === "boolean" ? undefined : raw, visited),
    };
  });
}

export function schemaRules(input: Schema, prefix = ""): string[] {
  const schema = resolve(input);
  const rules = (schema.required ?? []).map((name) => `${prefix}${name} is required.`);
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const fullName = `${prefix}${name}`;
    if (field === false) rules.push(`${fullName} must be absent.`);
    else if (typeof field === "object") {
      if (field.const !== undefined) rules.push(`${fullName} must be ${JSON.stringify(field.const)}.`);
      if (field.enum) rules.push(`${fullName} must be one of ${field.enum.map((value) => JSON.stringify(value)).join(", ")}.`);
      if (field.properties || field.required) rules.push(...schemaRules(field, `${fullName}.`));
    }
  }
  return rules;
}

function examples(media?: Media): ApiExample[] {
  if (!media) return [];
  if (media.example !== undefined) return [{ name: "Example", value: media.example }];
  return Object.entries(media.examples ?? {}).flatMap(([name, input]) => {
    const example = resolve(input);
    return example.value === undefined ? [] : [{ name, summary: example.summary, value: example.value }];
  });
}

function row(input: Parameter): SchemaRow {
  const parameter = resolve(input);
  return {
    name: parameter.name,
    type: [{ text: `${parameter.in} · ` }, ...typeParts(parameter.schema)],
    required: parameter.required ?? false,
    description: parameter.description ?? (parameter.schema && resolve(parameter.schema).description),
    enumValues: parameter.schema && resolve(parameter.schema).enum?.map(String),
  };
}

export function getApiGroups(): ApiGroup[] {
  const spec = getSpec();
  const groups = new Map(spec.tags.map((tag) => [tag.name, {
    tag: tag.name, slug: tag.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    title: tag.name, description: tag.description ?? "", operations: [] as ApiOperation[],
  }]));
  const methods: ApiMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  for (const [webhook, paths] of [[false, spec.paths], [true, spec.webhooks ?? {}]] as const) {
    for (const [route, item] of Object.entries(paths)) {
      for (const method of methods) {
        const op = item[method.toLowerCase() as Lowercase<ApiMethod>];
        if (!op) continue;
        const group = groups.get(op.tags?.[0] ?? "");
        if (!group) throw new Error(`Operation ${op.operationId} needs a declared tag.`);
        const body = op.requestBody && resolve(op.requestBody);
        const mediaEntry = body && Object.entries(body.content ?? {})[0];
        group.operations.push({
          id: op.operationId, method, path: webhook ? "Configured receiver URL" : route,
          webhook, summary: op.summary ?? op.operationId, description: op.description ?? "",
          auth: (op.security ?? spec.security ?? []).map((alternative) => Object.keys(alternative).map((name) => {
            const scheme = spec.components.securitySchemes[name];
            if (!scheme) throw new Error(`Unknown security scheme: ${name}`);
            return { name: name.replace(/([a-z])([A-Z])/g, "$1 $2"), description: scheme.description ?? scheme.type };
          })),
          parameters: [...(item.parameters ?? []), ...(op.parameters ?? [])].map(row),
          requestBody: mediaEntry ? {
            required: body?.required ?? false, contentType: mediaEntry[0],
            schema: mediaEntry[1].schema, examples: examples(mediaEntry[1]),
          } : undefined,
          responses: Object.entries(op.responses).map(([status, input]) => {
            const response = resolve(input);
            const media = response.content?.["application/json"];
            return {
              status, description: response.description ?? "", schema: media?.schema, examples: examples(media),
              headers: Object.entries(response.headers ?? {}).map(([name, header]) => row({ ...resolve(header), name, in: "header" })),
            };
          }).sort((a, b) => Number(a.status) - Number(b.status)),
        });
      }
    }
  }
  return [...groups.values()];
}

export function getApiSchemas(): ApiSchema[] {
  return Object.entries(getSpec().components.schemas).map(([name, schema]) => ({
    name, schema, fields: schemaFields({ $ref: `#/components/schemas/${name}` }),
  }));
}
