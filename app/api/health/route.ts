import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import { getWorkerHealth } from "@/lib/ops/worker-health";

export const runtime = "nodejs";
// Health must reflect live state (worker heartbeat, queue depth), never a
// cached response, or it reports stale worker start times.
export const dynamic = "force-dynamic";

type CheckStatus = "ok" | "warning" | "error";

interface HealthCheck {
  status: CheckStatus;
  detail?: string;
}

interface DatabaseHealthCheck extends HealthCheck {
  size?: {
    totalMb: number;
    status: CheckStatus;
    topRelations?: Array<{ name: string; sizeMb: number }>;
  };
}

const DB_SIZE_WARNING_MB = Number(process.env.DB_SIZE_WARNING_MB ?? 350);
const DB_SIZE_ERROR_MB = Number(process.env.DB_SIZE_ERROR_MB ?? 450);
const HEALTH_CHECK_TIMEOUT_MS = 5000;

// Track last alert time per status level to avoid spamming OperationalEvents
const lastAlertTime: Record<string, number> = {};

async function checkDatabase(): Promise<DatabaseHealthCheck> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Database check timeout")), HEALTH_CHECK_TIMEOUT_MS)
    );

    const [, sizeResult] = await Promise.race([
      Promise.all([
        prisma.$queryRaw`SELECT 1`,
        prisma.$queryRaw<[{ db_size_bytes: bigint }]>`
          SELECT pg_database_size(current_database()) AS db_size_bytes
        `,
      ]),
      timeoutPromise,
    ]);

    const dbSizeBytes = Number(sizeResult[0].db_size_bytes);
    const dbSizeMb = Math.round((dbSizeBytes / 1024 / 1024) * 100) / 100;

    let sizeStatus: CheckStatus = "ok";
    if (dbSizeMb >= DB_SIZE_ERROR_MB) {
      sizeStatus = "error";
    } else if (dbSizeMb >= DB_SIZE_WARNING_MB) {
      sizeStatus = "warning";
    }

    // Get top 5 relations by size
    const topRelations = await Promise.race([
      prisma.$queryRaw<Array<{ name: string; size_bytes: bigint }>>`
        SELECT
          relname AS name,
          pg_total_relation_size(C.oid) AS size_bytes
        FROM pg_class C
        LEFT JOIN pg_namespace N ON (N.oid = C.relnamespace)
        WHERE nspname = 'public'
        ORDER BY pg_total_relation_size(C.oid) DESC
        LIMIT 5
      `,
      timeoutPromise,
    ]);

    const topRelationsMapped = topRelations.map((r) => ({
      name: r.name,
      sizeMb: Math.round((Number(r.size_bytes) / 1024 / 1024) * 100) / 100,
    }));

    // Record OperationalEvent if size is warning or error (at most once per day)
    if (sizeStatus !== "ok") {
      const alertKey = `db_size_${sizeStatus}`;
      const now = Date.now();
      const lastAlert = lastAlertTime[alertKey] || 0;
      const dayInMs = 24 * 60 * 60 * 1000;

      if (now - lastAlert > dayInMs) {
        lastAlertTime[alertKey] = now;
        await prisma.operationalEvent
          .create({
            data: {
              source: "HEALTH",
              level: sizeStatus === "error" ? "ERROR" : "WARNING",
              message: `Database size ${sizeStatus}: ${dbSizeMb} MB (threshold: ${
                sizeStatus === "error" ? DB_SIZE_ERROR_MB : DB_SIZE_WARNING_MB
              } MB)`,
              payload: { dbSizeMb, topRelations: topRelationsMapped },
            },
          })
          .catch(() => {});
      }
    }

    return {
      status: "ok",
      size: {
        totalMb: dbSizeMb,
        status: sizeStatus,
        topRelations: topRelationsMapped,
      },
    };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Database check failed",
    };
  }
}

async function checkRedis(): Promise<HealthCheck> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Redis check timeout")), HEALTH_CHECK_TIMEOUT_MS)
    );

    const pong = await Promise.race([
      getRedisConnection().ping(),
      timeoutPromise,
    ]);

    return { status: pong === "PONG" ? "ok" : "error", detail: pong };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Redis check failed",
    };
  }
}

async function checkQueue(): Promise<HealthCheck & { counts?: unknown }> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Queue check timeout")), HEALTH_CHECK_TIMEOUT_MS)
    );

    const counts = await Promise.race([
      getDMQueue().getJobCounts("waiting", "active", "delayed", "failed"),
      timeoutPromise,
    ]);

    return { status: "ok", counts };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Queue check failed",
    };
  }
}

export async function GET() {
  // Worker health is based on heartbeat age vs TTL. With reduced-frequency
  // heartbeats (default 5 min) and a 12 min TTL, the worker is healthy as long
  // as the last heartbeat was within 12 minutes (allowing 2-3 missed intervals).
  const [database, redis, queue, worker] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkQueue(),
    getWorkerHealth().catch((error) => ({
      healthy: false,
      heartbeat: null,
      ageMs: null,
      error: error instanceof Error ? error.message : "Worker check failed",
    })),
  ]);

  const healthy =
    database.status === "ok" &&
    redis.status === "ok" &&
    queue.status === "ok" &&
    worker.healthy;

  // Overall status: "ok" if healthy, "degraded" if any check failed but keep 200 on warnings
  const overallStatus =
    healthy && database.size?.status === "ok" ? "ok" : "degraded";
  const httpStatus = database.status === "error" || !healthy ? 503 : 200;

  return NextResponse.json(
    {
      status: overallStatus,
      checks: {
        database,
        redis,
        queue,
        worker,
      },
    },
    { status: httpStatus }
  );
}
