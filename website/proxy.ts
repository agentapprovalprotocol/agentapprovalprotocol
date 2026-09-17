import { NextResponse, type NextRequest } from "next/server";
import { isDocumentPath } from "./lib/doc-pages";
import { markdownVary, negotiateDocument } from "./lib/markdown-negotiation";

function isNavigationRequest(headers: Headers): boolean {
  return ["rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch"].some((name) => headers.has(name))
    || /\bprefetch\b/i.test(`${headers.get("purpose") ?? ""} ${headers.get("sec-purpose") ?? ""}`);
}

export function proxy(request: NextRequest) {
  if (!["GET", "HEAD"].includes(request.method) || !isDocumentPath(request.nextUrl.pathname)) return NextResponse.next();

  const url = request.nextUrl.clone();
  const format = isNavigationRequest(request.headers) ? "html" : negotiateDocument(request.headers.get("accept"));
  if (format === null) {
    return new NextResponse(request.method === "HEAD" ? null : "Not Acceptable\n\nAvailable representations: text/html, text/markdown.\n", {
      status: 406,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Vary: markdownVary },
    });
  }
  if (format === "markdown") url.pathname += "/index.md";

  const response = format === "markdown" ? NextResponse.rewrite(url) : NextResponse.next();
  // Next.js appends its own RSC/router Vary fields when serving either route.
  response.headers.append("Vary", markdownVary);
  return response;
}

export const config = {
  matcher: ["/docs/:path*", "/specification/:path*"],
};
