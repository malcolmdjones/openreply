import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import {
  parseCommentEvents,
  parseMessageEvents,
  parsePostbackEvents,
  parseReadEvents,
  verifyWebhookSignature,
} from "@/lib/meta/webhook";
import { MESSAGE_JOB_NAME, POSTBACK_JOB_NAME } from "@/lib/queue/client";
import { Prisma } from "@/app/generated/prisma/client";
import { createHash } from "crypto";

const OPENING_DM_READ_FALLBACK_DELAY_MS = 5 * 60 * 1000;

// Track last signature-failure alert time to rate-limit spam
let lastSignatureFailureAlert = 0;
const SIGNATURE_FAILURE_ALERT_INTERVAL_MS = 10 * 60 * 1000;

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json(
    { success: false, error: "Verification failed" },
    { status: 403 }
  );
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyWebhookSignature(rawBody, signature)) {
    // Rate-limit signature-failure OperationalEvent: at most one per 10 minutes
    const now = Date.now();
    if (now - lastSignatureFailureAlert > SIGNATURE_FAILURE_ALERT_INTERVAL_MS) {
      lastSignatureFailureAlert = now;
      await prisma.operationalEvent
        .create({
          data: {
            source: "SYSTEM",
            level: "WARNING",
            message: "Webhook signature verification failed",
            payload: {
              hadSignatureHeader: Boolean(signature),
              bodyLength: rawBody.length,
              bodyPreview: rawBody.slice(0, 200),
            },
          },
        })
        .catch(() => {});
    }
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 }
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  // Check if there are any actionable events before persisting
  const commentEvents = parseCommentEvents(
    payload as Parameters<typeof parseCommentEvents>[0]
  );
  const postbackEvents = parsePostbackEvents(
    payload as Parameters<typeof parsePostbackEvents>[0]
  );
  const messageEvents = parseMessageEvents(
    payload as Parameters<typeof parseMessageEvents>[0]
  );
  const readEvents = parseReadEvents(
    payload as Parameters<typeof parseReadEvents>[0]
  );

  const hasActionableEvents =
    commentEvents.length > 0 ||
    postbackEvents.length > 0 ||
    messageEvents.length > 0 ||
    readEvents.length > 0;

  // Skip persisting non-actionable events (read receipts without opening DMs, echoes, etc.)
  if (!hasActionableEvents) {
    return NextResponse.json({ success: true }, { status: 200 });
  }

  // Dedupe retries: generate a deterministic hash from the payload
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16);

  // Check if we've already stored this exact payload
  const existing = await prisma.webhookEvent.findFirst({
    where: {
      id: { startsWith: `wh_${payloadHash}` },
    },
    select: { id: true },
  });

  if (existing) {
    // Already processed this webhook (retry from Meta), return 200
    return NextResponse.json({ success: true }, { status: 200 });
  }

  // Determine workspaceId from the first event's Instagram account
  let workspaceId: string | null = null;
  const firstInstagramAccountId =
    commentEvents[0]?.instagramAccountId ||
    postbackEvents[0]?.instagramAccountId ||
    messageEvents[0]?.instagramAccountId ||
    readEvents[0]?.instagramAccountId;

  if (firstInstagramAccountId) {
    const account = await prisma.instagramAccount.findUnique({
      where: { instagramId: firstInstagramAccountId },
      select: { workspaceId: true },
    });
    workspaceId = account?.workspaceId ?? null;
  }

  // Create WebhookEvent with deterministic ID for deduplication and workspaceId set at insert
  const webhookEvent = await prisma.webhookEvent.create({
    data: {
      id: `wh_${payloadHash}_${Date.now()}`,
      workspaceId,
      object:
        typeof payload === "object" && payload && "object" in payload
          ? String(payload.object)
          : null,
      payload: payload as Prisma.InputJsonValue,
      status: "PENDING",
    },
  });

  try {
    const queue = getDMQueue();

    for (const event of commentEvents) {
      await queue.add(
        "process-comment",
        {
          instagramAccountId: event.instagramAccountId,
          commentId: event.commentId,
          commentText: event.commentText,
          commenterId: event.commenterId,
          commenterName: event.commenterName,
          mediaId: event.mediaId,
          originalMediaId: event.originalMediaId,
          source: "WEBHOOK",
        },
        {
          jobId: `comment_${event.instagramAccountId}_${event.commentId}`,
        }
      );
    }

    // Button taps from opening DMs → deliver the reveal message.
    for (const event of postbackEvents) {
      await queue.add(
        POSTBACK_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
          userId: event.userId,
          payload: event.payload,
          mid: event.mid,
        },
        {
          // BullMQ forbids ":" in custom job ids, and the payload is
          // "reveal:<id>", so build with underscores and strip any colons.
          jobId: `postback_${event.instagramAccountId}_${event.userId}_${(
            event.mid ?? event.payload
          ).replace(/:/g, "_")}`,
        }
      );
    }

    // Inbound DMs → keyword-triggered autoreply.
    for (const event of messageEvents) {
      await queue.add(
        MESSAGE_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
          messageId: event.messageId,
          messageText: event.messageText,
          senderId: event.senderId,
        },
        {
          // Message ids can contain characters BullMQ rejects in a job id (":"
          // in particular). base64url encodes into exactly the allowed alphabet
          // and stays injective — substituting invalid characters would let two
          // distinct mids collapse onto one job id, silently dropping a reply.
          jobId: `message_${event.instagramAccountId}_${Buffer.from(
            event.messageId
          ).toString("base64url")}`,
        }
      );
    }

    // If a user reads the opening DM and never taps the button, deliver the
    // same next-step DM after five minutes. The worker no-ops this delayed job
    // if a real button tap has already delivered the reveal.
    for (const event of readEvents) {
      const openingLogs = await prisma.dmLog.findMany({
        where: {
          commenterId: event.userId,
          status: "SENT",
          automation: {
            isActive: true,
            openingDmEnabled: true,
            instagramAccount: {
              instagramId: event.instagramAccountId,
            },
          },
        },
        select: {
          automation: {
            select: {
              id: true,
            },
          },
        },
      });

      const scheduledAutomationIds = new Set<string>();
      for (const log of openingLogs) {
        const automation = log.automation;
        if (scheduledAutomationIds.has(automation.id)) continue;
        scheduledAutomationIds.add(automation.id);

        await queue.add(
          POSTBACK_JOB_NAME,
          {
            instagramAccountId: event.instagramAccountId,
            userId: event.userId,
            payload: `reveal:${automation.id}`,
            fallback: true,
          },
          {
            delay: OPENING_DM_READ_FALLBACK_DELAY_MS,
            jobId: `read_fallback_${event.instagramAccountId}_${event.userId}_${automation.id}`,
          }
        );
      }
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "FAILED",
        errorMessage: message,
        processedAt: new Date(),
      },
    });

    return NextResponse.json(
      { success: false, error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
