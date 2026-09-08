import { NextRequest, NextResponse } from "next/server";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { getBaseUrl, getMissingInstagramOAuthEnv } from "@/lib/env";
import { createOAuthState, getAuthorizationUrl } from "@/lib/meta/oauth";

export const runtime = "nodejs";

function appUrl(path: string, request: NextRequest): string {
  // Prefer the incoming request origin so redirects stay absolute even when
  // NEXTAUTH_URL is missing/empty. Fall back to getBaseUrl() for safety.
  const base = request.url || getBaseUrl();
  return new URL(path, base).toString();
}

export async function GET(request: NextRequest) {
  try {
    const context = await getCurrentWorkspaceContext();
    if (!context) {
      return NextResponse.redirect(appUrl("/login", request));
    }
    if (!canManageWorkspace(context.role)) {
      return NextResponse.redirect(appUrl("/settings?instagram=forbidden", request));
    }

    // getAuthorizationUrl and createOAuthState call requireEnv, which throws.
    // Without this check an incomplete .env surfaces as a 500 on a plain <a>
    // navigation, which reads to the user as the button doing nothing at all.
    const missingEnv = getMissingInstagramOAuthEnv();
    if (missingEnv.length > 0) {
      return NextResponse.redirect(
        appUrl(
          `/settings?instagram=misconfigured&missing=${encodeURIComponent(
            missingEnv.join(",")
          )}`,
          request
        )
      );
    }

    // OAuth redirect_uri must match the registered public URL (NEXTAUTH_URL).
    const redirectUri = `${getBaseUrl()}/api/instagram/callback`;
    const state = createOAuthState(context.workspaceId);

    return NextResponse.redirect(getAuthorizationUrl(redirectUri, state));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Instagram Connect] Error:", message);
    return NextResponse.redirect(appUrl("/settings?instagram=error", request));
  }
}
