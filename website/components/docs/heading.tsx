import { Children, isValidElement, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { AnchorIcon } from "./api/anchor-icon";

function headingText(children: ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (isValidElement<{ children?: ReactNode }>(child)) return headingText(child.props.children);
    return typeof child === "string" || typeof child === "number" ? String(child) : "";
  }).join("");
}

export function Heading({
  as: Tag = "h2", id, children, className, ...props
}: ComponentPropsWithoutRef<"h2"> & { as?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" }) {
  return <Tag {...props} id={id} className={["docs-heading", className].filter(Boolean).join(" ")}>
    {children}
    {id && <a href={`#${id}`} className="docs-api-anchor" aria-label={`Link to ${headingText(children)}`}><AnchorIcon /></a>}
  </Tag>;
}
