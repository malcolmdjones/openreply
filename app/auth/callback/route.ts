import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { ensurePrismaUserForAuthUser } from "@/lib/auth";
import { isEmailAllowedToSignIn } from "@/lib/env";
import { ensureWorkspaceForUser } from "@/lib/workspace";

function safeNextPath(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) {
    return "/dashboard";
  }
  return next;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));
  const errorParam = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  if (errorParam) {
    const loginUrl = new URL("/login", origin);
    loginUrl.searchParams.set(
      "error",
      errorDescription || errorParam || "oauth_error"
    );
    return NextResponse.redirect(loginUrl);
  }

  if (!code) {
    const loginUrl = new URL("/login", origin);
    loginUrl.searchParams.set("error", "missing_code");
    return NextResponse.redirect(loginUrl);
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        },
      },
    }
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    const loginUrl = new URL("/login", origin);
    loginUrl.searchParams.set("error", "exchange_failed");
    return NextResponse.redirect(loginUrl);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email || !isEmailAllowedToSignIn(user.email)) {
    await supabase.auth.signOut();
    const loginUrl = new URL("/login", origin);
    loginUrl.searchParams.set("error", "not_allowed");
    return NextResponse.redirect(loginUrl);
  }

  const prismaUser = await ensurePrismaUserForAuthUser(user);
  if (!prismaUser) {
    await supabase.auth.signOut();
    const loginUrl = new URL("/login", origin);
    loginUrl.searchParams.set("error", "user_sync_failed");
    return NextResponse.redirect(loginUrl);
  }

  await ensureWorkspaceForUser(prismaUser.id, prismaUser.email);

  return NextResponse.redirect(new URL(next, origin));
}
