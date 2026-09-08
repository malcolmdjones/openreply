import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { canConnectInstagramAccount } from "@/lib/instagram-accounts";
import { getLongLivedToken, getUserInfo, subscribeInstagramAccountToWebhooks } from "@/lib/meta/client";
import {
  encryptToken,
  exchangeCodeForToken,
  verifyOAuthState,
} from "@/lib/meta/oauth";
import { canManageWorkspace } from "@/lib/workspace-access";

export const runtime = "nodejs";

function appUrl(path: string, request: NextRequest): string {
  const base = request.url || getBaseUrl();
  return new URL(path, base).toString();
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");
  const state = verifyOAuthState(request.nextUrl.searchParams.get("state"));

  if (error) {
    return NextResponse.redirect(appUrl("/settings?instagram=denied", request));
  }

  if (!code || !state) {
    return NextResponse.redirect(appUrl("/settings?instagram=invalid", request));
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(appUrl("/login", request));
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: {
      workspaceId: state.workspaceId,
      userId: session.user.id,
    },
  });

  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.redirect(appUrl("/settings?instagram=forbidden", request));
  }

  try {
    // OAuth redirect_uri must match the registered public URL (NEXTAUTH_URL).
    const redirectUri = `${getBaseUrl()}/api/instagram/callback`;
    const { accessToken: shortLivedToken } = await exchangeCodeForToken(
      code,
      redirectUri
    );
    const { accessToken: longLivedToken, expiresIn } =
      await getLongLivedToken(shortLivedToken);
    const userInfo = await getUserInfo(longLivedToken);
    // Webhooks and the messaging API key off the professional account ID
    // (user_id), not the app-scoped `id`. Store user_id so comment webhooks
    // can be matched back to this account. Fall back to id if user_id is
    // ever absent.
    const instagramId = userInfo.user_id ?? userInfo.id;
    const connection = await canConnectInstagramAccount({
      workspaceId: state.workspaceId,
      instagramId,
    });

    if (!connection.allowed) {
      return NextResponse.redirect(
        appUrl("/settings?instagram=already_connected", request)
      );
    }

    const encryptedToken = encryptToken(longLivedToken);
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

    let webhookSubscribed = false;
    try {
      const subscription = await subscribeInstagramAccountToWebhooks(
        instagramId,
        longLivedToken
      );
      webhookSubscribed = Boolean(subscription.success);
    } catch (subscriptionError) {
      console.warn(
        "[Instagram Callback] Webhook subscription failed:",
        subscriptionError
      );
    }

    await prisma.instagramAccount.upsert({
      where: { instagramId },
      create: {
        workspaceId: state.workspaceId,
        instagramId,
        username: userInfo.username,
        name: userInfo.name,
        accessToken: encryptedToken,
        tokenExpiresAt,
        webhookSubscribed,
      },
      update: {
        workspaceId: state.workspaceId,
        username: userInfo.username,
        name: userInfo.name,
        accessToken: encryptedToken,
        tokenExpiresAt,
        webhookSubscribed,
      },
    });

    return NextResponse.redirect(appUrl("/dashboard?connected=true", request));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Instagram Callback] Error:", err);
    // The message is the only diagnostic a self-hoster gets for a failed
    // connect, so persist it alongside the other operational events rather
    // than leaving it in server logs they may not be able to reach.
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "ERROR",
          workspaceId: state.workspaceId,
          message: "Instagram connection failed",
          payload: { reason: message },
        },
      })
      .catch(() => {});

    return NextResponse.redirect(
      appUrl(
        `/settings?instagram=failed&reason=${encodeURIComponent(
          message.slice(0, 200)
        )}`,
        request
      )
    );
  }
}
