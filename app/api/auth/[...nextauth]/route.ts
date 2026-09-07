/**
 * Legacy Auth.js / NextAuth route.
 *
 * Primary login is now Supabase Google OAuth (`/auth/callback`).
 * This handler is kept so old bookmarks to `/api/auth/*` do not 404;
 * it redirects to the Google login page.
 */

import { NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/env";

function redirectToLogin() {
  return NextResponse.redirect(new URL("/login", getBaseUrl()));
}

export async function GET() {
  return redirectToLogin();
}

export async function POST() {
  return redirectToLogin();
}
