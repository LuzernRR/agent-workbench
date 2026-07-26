import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { VISITOR_COOKIE, createVisitorToken, isVisitorToken } from "@/lib/visitor-session";

/** Keep the public prefix compatible and establish an anonymous browser identity. */
export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  let response: NextResponse;
  if (pathname.startsWith("/workbench/api/")) {
    const target = request.nextUrl.clone();
    target.pathname = pathname.slice("/workbench".length) || "/";
    response = NextResponse.rewrite(target);
  } else {
    response = NextResponse.next();
  }
  const existing = request.cookies.get(VISITOR_COOKIE)?.value;
  if (!isVisitorToken(existing)) {
    response.cookies.set(VISITOR_COOKIE, createVisitorToken(), {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 365 * 24 * 60 * 60
    });
  }
  return response;
}

export const config = { matcher: ["/", "/workbench/:path*", "/api/:path*"] };
