import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/** Keep the public /workbench prefix compatible with existing front-end links. */
export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (!pathname.startsWith("/workbench/api/")) return NextResponse.next();
  const target = request.nextUrl.clone();
  target.pathname = pathname.slice("/workbench".length) || "/";
  return NextResponse.rewrite(target);
}

export const config = { matcher: ["/workbench/api/:path*"] };
