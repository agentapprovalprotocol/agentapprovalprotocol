import { cn } from "@/lib/cn";
import type { ApiMethod } from "@/lib/openapi";

/* HTTP method badge, colour-coded on the theme-aware tints so the decision
 * greens and reds keep their meaning: reads are green, creates blue, updates
 * purple, and DELETE alone borrows the deny soft tint. */
const methodClasses: Record<ApiMethod, string> = {
  GET: "bg-tint-green text-on-tint-green",
  POST: "bg-tint-blue text-on-tint",
  PUT: "bg-tint-purple text-on-tint",
  PATCH: "bg-tint-purple text-on-tint",
  DELETE: "bg-deny-soft text-deny-strong",
};

export function MethodPill({
  method,
  size = "md",
}: {
  method: ApiMethod;
  size?: "sm" | "md";
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md font-mono font-medium leading-none tracking-[0.04em]",
        size === "md" ? "px-1.5 py-1 text-[0.6875rem]" : "px-1 py-[0.1875rem] text-[0.5625rem]",
        methodClasses[method],
      )}
    >
      {method}
    </span>
  );
}
