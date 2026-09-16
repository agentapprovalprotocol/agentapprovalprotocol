import type { SchemaRow } from "@/lib/openapi";
import { AnchorIcon } from "./anchor-icon";
import { Description } from "./description";
import { TypeLabel } from "./type-label";

/* Flat table for parameters: the framed docs table look. Bodies use the
 * expandable FieldList instead. */
export function SchemaTable({
  rows,
  nameHeading = "Field",
  anchorPrefix,
}: {
  rows: SchemaRow[];
  nameHeading?: string;
  /** When set, each row gets an id of `<prefix>-<name>` and the name links to it. */
  anchorPrefix?: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="blog-table-wrap">
      <table className="docs-api-table">
        <thead>
          <tr>
            <th>{nameHeading}</th>
            <th>Type</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={`${row.name}-${index}`}
              id={anchorPrefix ? `${anchorPrefix}-${row.name}` : undefined}
            >
              <td>
                <span className="docs-api-name">
                  {anchorPrefix ? (
                    <a
                      href={`#${anchorPrefix}-${row.name}`}
                      className="docs-api-row-anchor"
                    >
                      <code>{row.name}</code>
                      <AnchorIcon />
                    </a>
                  ) : (
                    <code>{row.name}</code>
                  )}
                  {row.required && (
                    <span className="docs-api-required">required</span>
                  )}
                </span>
              </td>
              <td className="docs-api-type">
                <TypeLabel parts={row.type} />
              </td>
              <td>
                {row.description && <Description text={row.description} />}
                {row.enumValues && (
                  <div className="docs-api-enum">
                    One of{" "}
                    {row.enumValues.map((value, i) => (
                      <span key={value}>
                        <code>{value}</code>
                        {i < row.enumValues!.length - 1 ? ", " : ""}
                      </span>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
