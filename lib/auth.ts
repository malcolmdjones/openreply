import { prisma } from "@/lib/db/client";
import { isEmailAllowedToSignIn } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { ensureWorkspaceForUser, getPrimaryWorkspace } from "@/lib/workspace";
import type { User as PrismaUser } from "@/app/generated/prisma/client";
import type { User as SupabaseUser } from "@supabase/supabase-js";

export type AppSession = {
  user: {
    id: string;
    email: string | null;
    name?: string | null;
    image?: string | null;
  };
};

function displayNameFromSupabase(user: SupabaseUser): string | null {
  const meta = user.user_metadata ?? {};
  return (
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    null
  );
}

function avatarFromSupabase(user: SupabaseUser): string | null {
  const meta = user.user_metadata ?? {};
  return (
    (typeof meta.avatar_url === "string" && meta.avatar_url) ||
    (typeof meta.picture === "string" && meta.picture) ||
    null
  );
}

/**
 * Map a Supabase Auth user onto the Prisma User row (find/upsert by email)
 * so existing workspaces and Instagram campaigns keep working.
 */
export async function ensurePrismaUserForAuthUser(
  supabaseUser: SupabaseUser
): Promise<PrismaUser | null> {
  const email = supabaseUser.email?.trim().toLowerCase();
  if (!email) return null;

  const name = displayNameFromSupabase(supabaseUser);
  const image = avatarFromSupabase(supabaseUser);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    const needsUpdate =
      (name && existing.name !== name) || (image && existing.image !== image);
    if (!needsUpdate) return existing;

    return prisma.user.update({
      where: { id: existing.id },
      data: {
        ...(name ? { name } : {}),
        ...(image ? { image } : {}),
      },
    });
  }

  return prisma.user.create({
    data: {
      email,
      name,
      image,
      emailVerified: new Date(),
    },
  });
}

export async function auth(): Promise<AppSession | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) return null;

  if (!isEmailAllowedToSignIn(user.email)) {
    await supabase.auth.signOut();
    return null;
  }

  const prismaUser = await ensurePrismaUserForAuthUser(user);
  if (!prismaUser) return null;

  return {
    user: {
      id: prismaUser.id,
      email: prismaUser.email,
      name: prismaUser.name,
      image: prismaUser.image,
    },
  };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
}

export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

export async function getCurrentWorkspaceId(): Promise<string | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;

  const workspace = await getPrimaryWorkspace(userId);
  if (workspace) return workspace.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  const createdWorkspace = await ensureWorkspaceForUser(userId, user?.email);
  return createdWorkspace.id;
}
