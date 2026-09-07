import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/automations",
  "/logs",
  "/settings",
  "/overview",
  "/inbox",
  "/campaigns",
  "/diagnostics",
];

function withSessionCookies(
  target: NextResponse,
  sessionResponse: NextResponse
) {
  sessionResponse.cookies.getAll().forEach((cookie) => {
    target.cookies.set(cookie.name, cookie.value);
  });
  return target;
}

export async function proxy(request: NextRequest) {
  const { response, user } = await updateSession(request);

  const pathname = request.nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
  const isLogin = pathname === "/login";
  const isAuthenticated = Boolean(user);

  if (isProtected && !isAuthenticated) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return withSessionCookies(NextResponse.redirect(loginUrl), response);
  }

  if (isLogin && isAuthenticated) {
    return withSessionCookies(
      NextResponse.redirect(new URL("/dashboard", request.url)),
      response
    );
  }

  return response;
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/automations/:path*",
    "/logs/:path*",
    "/settings/:path*",
    "/overview/:path*",
    "/inbox/:path*",
    "/campaigns/:path*",
    "/diagnostics/:path*",
    "/login",
    "/auth/callback",
  ],
};
