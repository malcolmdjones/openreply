import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";

const MAX_FUNCTION_TIME_MS = 50000;
const BATCH_SIZE = 5000;

function getRetentionConfig() {
  return {
    webhookEventDays: Number(process.env.DB_RETENTION_WEBHOOK_EVENT_DAYS ?? 7),
    webhookEventWithMediaDays: Number(
      process.env.DB_RETENTION_WEBHOOK_EVENT_WITH_MEDIA_DAYS ?? 90
    ),
    operationalEventInfoDays: Number(
      process.env.DB_RETENTION_OPERATIONAL_EVENT_INFO_DAYS ?? 14
    ),
    operationalEventAllDays: Number(
      process.env.DB_RETENTION_OPERATIONAL_EVENT_ALL_DAYS ?? 60
    ),
    linkClickDays: Number(process.env.DB_RETENTION_LINK_CLICK_DAYS ?? 180),
    dmLogDays: Number(process.env.DB_RETENTION_DM_LOG_DAYS ?? 180),
    dmLogScrubDays: Number(process.env.DB_RETENTION_DM_LOG_SCRUB_DAYS ?? 30),
  };
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const startTime = Date.now();
  const config = getRetentionConfig();
  const results: Record<string, number> = {
    webhookEventsDeleted: 0,
    operationalEventsDeleted: 0,
    linkClicksDeleted: 0,
    dmLogsScrubbed: 0,
    dmLogsDeleted: 0,
    sessionsDeleted: 0,
    verificationTokensDeleted: 0,
  };

  try {
    // 1. Prune WebhookEvent: older than 7 days except those with original_media_id (keep 90 days)
    const webhookCutoff7 = new Date(
      Date.now() - config.webhookEventDays * 24 * 60 * 60 * 1000
    );
    const webhookCutoff90 = new Date(
      Date.now() - config.webhookEventWithMediaDays * 24 * 60 * 60 * 1000
    );

    while (Date.now() - startTime < MAX_FUNCTION_TIME_MS) {
      const idsToDelete = await prisma.$queryRaw<{ id: string }[]>`
        SELECT w.id
        FROM "WebhookEvent" w
        WHERE (
          (w."createdAt" < ${webhookCutoff7}
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(w.payload::jsonb->'entry') entry,
                   jsonb_array_elements(entry->'changes') change
              WHERE change->'value'->'media'->>'original_media_id' IS NOT NULL
            ))
          OR w."createdAt" < ${webhookCutoff90}
        )
        LIMIT ${BATCH_SIZE}
      `;

      if (idsToDelete.length === 0) break;

      const deleted = await prisma.webhookEvent.deleteMany({
        where: { id: { in: idsToDelete.map((r) => r.id) } },
      });
      results.webhookEventsDeleted += deleted.count;

      if (idsToDelete.length < BATCH_SIZE) break;
    }

    // 2. Prune OperationalEvent: INFO older than 14 days, everything older than 60 days
    const opEventInfoCutoff = new Date(
      Date.now() - config.operationalEventInfoDays * 24 * 60 * 60 * 1000
    );
    const opEventAllCutoff = new Date(
      Date.now() - config.operationalEventAllDays * 24 * 60 * 60 * 1000
    );

    while (Date.now() - startTime < MAX_FUNCTION_TIME_MS) {
      const toDelete = await prisma.operationalEvent.findMany({
        where: {
          OR: [
            { level: "INFO", createdAt: { lt: opEventInfoCutoff } },
            { createdAt: { lt: opEventAllCutoff } },
          ],
        },
        select: { id: true },
        take: BATCH_SIZE,
      });

      if (toDelete.length === 0) break;

      const deleted = await prisma.operationalEvent.deleteMany({
        where: { id: { in: toDelete.map((r) => r.id) } },
      });
      results.operationalEventsDeleted += deleted.count;

      if (toDelete.length < BATCH_SIZE) break;
    }

    // 3. Prune LinkClick: older than 180 days
    const linkClickCutoff = new Date(
      Date.now() - config.linkClickDays * 24 * 60 * 60 * 1000
    );

    while (Date.now() - startTime < MAX_FUNCTION_TIME_MS) {
      const toDelete = await prisma.linkClick.findMany({
        where: { createdAt: { lt: linkClickCutoff } },
        select: { id: true },
        take: BATCH_SIZE,
      });

      if (toDelete.length === 0) break;

      const deleted = await prisma.linkClick.deleteMany({
        where: { id: { in: toDelete.map((r) => r.id) } },
      });
      results.linkClicksDeleted += deleted.count;

      if (toDelete.length < BATCH_SIZE) break;
    }

    // 4. Scrub DmLog: commentText/commenterName after 30 days, delete after 180 days
    const dmLogScrubCutoff = new Date(
      Date.now() - config.dmLogScrubDays * 24 * 60 * 60 * 1000
    );
    const dmLogDeleteCutoff = new Date(
      Date.now() - config.dmLogDays * 24 * 60 * 60 * 1000
    );

    // Scrub PII from old DmLog rows
    while (Date.now() - startTime < MAX_FUNCTION_TIME_MS) {
      const toScrub = await prisma.dmLog.findMany({
        where: {
          createdAt: { lt: dmLogScrubCutoff, gte: dmLogDeleteCutoff },
          OR: [
            { commentText: { not: "[scrubbed]" } },
            { commenterName: { not: null } },
          ],
        },
        select: { id: true },
        take: BATCH_SIZE,
      });

      if (toScrub.length === 0) break;

      const scrubbed = await prisma.dmLog.updateMany({
        where: { id: { in: toScrub.map((r) => r.id) } },
        data: {
          commentText: "[scrubbed]",
          commenterName: null,
        },
      });
      results.dmLogsScrubbed += scrubbed.count;

      if (toScrub.length < BATCH_SIZE) break;
    }

    // Delete very old DmLog rows
    while (Date.now() - startTime < MAX_FUNCTION_TIME_MS) {
      const toDelete = await prisma.dmLog.findMany({
        where: { createdAt: { lt: dmLogDeleteCutoff } },
        select: { id: true },
        take: BATCH_SIZE,
      });

      if (toDelete.length === 0) break;

      const deleted = await prisma.dmLog.deleteMany({
        where: { id: { in: toDelete.map((r) => r.id) } },
      });
      results.dmLogsDeleted += deleted.count;

      if (toDelete.length < BATCH_SIZE) break;
    }

    // 5. Prune expired Session and VerificationToken
    const now = new Date();

    while (Date.now() - startTime < MAX_FUNCTION_TIME_MS) {
      const toDelete = await prisma.session.findMany({
        where: { expires: { lt: now } },
        select: { id: true },
        take: BATCH_SIZE,
      });

      if (toDelete.length === 0) break;

      const deleted = await prisma.session.deleteMany({
        where: { id: { in: toDelete.map((r) => r.id) } },
      });
      results.sessionsDeleted += deleted.count;

      if (toDelete.length < BATCH_SIZE) break;
    }

    while (Date.now() - startTime < MAX_FUNCTION_TIME_MS) {
      const toDelete = await prisma.verificationToken.findMany({
        where: { expires: { lt: now } },
        select: { identifier: true, token: true },
        take: BATCH_SIZE,
      });

      if (toDelete.length === 0) break;

      for (const vt of toDelete) {
        await prisma.verificationToken.delete({
          where: { identifier_token: { identifier: vt.identifier, token: vt.token } },
        });
        results.verificationTokensDeleted += 1;
      }

      if (toDelete.length < BATCH_SIZE) break;
    }

    return NextResponse.json({
      success: true,
      data: {
        ...results,
        durationMs: Date.now() - startTime,
        config,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      {
        success: false,
        error: "Prune failed",
        details: message,
        partialResults: results,
      },
      { status: 500 }
    );
  }
}
