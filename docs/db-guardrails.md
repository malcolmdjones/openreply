# Database Guardrails

OpenReply runs on Supabase's free Postgres tier, which has a hard limit of 500 MB. Once a database exceeds that limit, a paused project cannot be restored and all data is lost. These guardrails prevent that.

## What protects the database

### 1. Automated pruning

A daily cron job (`/api/cron/prune`) deletes old data according to the retention policy below. It runs batched deletes with a time budget to stay within serverless function limits.

**Retention policy (configurable via environment variables):**

| Table | Policy | Default |
| --- | --- | --- |
| `WebhookEvent` | Deleted after 7 days, **except** rows containing `original_media_id` which are kept 90 days (needed for `adMediaFor` lookups) | 7 / 90 days |
| `OperationalEvent` | INFO level deleted after 14 days; all levels deleted after 60 days | 14 / 60 days |
| `LinkClick` | Deleted after 180 days | 180 days |
| `DmLog` | `commentText` and `commenterName` scrubbed after 30 days; entire row deleted after 180 days | 30 / 180 days |
| `Session` | Deleted when expired (NextAuth sessions) | on expiry |
| `VerificationToken` | Deleted when expired (magic link tokens) | on expiry |

The cron returns a JSON summary of rows deleted:

```json
{
  "success": true,
  "data": {
    "webhookEventsDeleted": 1234,
    "operationalEventsDeleted": 567,
    "linkClicksDeleted": 89,
    "dmLogsScrubbed": 45,
    "dmLogsDeleted": 12,
    "sessionsDeleted": 3,
    "verificationTokensDeleted": 1,
    "durationMs": 4521,
    "config": { ... }
  }
}
```

**Important:** Pruning reclaims disk space only after Postgres's automatic VACUUM runs. Deleted rows are marked for reuse but the file does not shrink immediately. Manual VACUUM FULL (which locks the table and rewrites it) is not possible via Prisma in a transaction and is not recommended on a live database.

### 2. Database size monitoring

The `/api/health` endpoint checks database size on every call and reports:

- **`ok`**: below 350 MB (default)
- **`warning`**: 350–450 MB (default)
- **`error`**: above 450 MB (default)

Thresholds are configurable via `DB_SIZE_WARNING_MB` and `DB_SIZE_ERROR_MB`.

A `warning` or `error` status writes an `OperationalEvent` (level WARNING or ERROR) at most once per day, so you get alerted without spam. The HTTP response stays `200` on `warning` and only becomes `503` on `error`.

The health check returns the total database size and the top 5 tables by size:

```json
{
  "status": "ok",
  "checks": {
    "database": {
      "status": "ok",
      "size": {
        "totalMb": 127.45,
        "status": "ok",
        "topRelations": [
          { "name": "WebhookEvent", "sizeMb": 89.2 },
          { "name": "DmLog", "sizeMb": 23.1 },
          { "name": "OperationalEvent", "sizeMb": 8.7 },
          { "name": "LinkClick", "sizeMb": 4.3 },
          { "name": "Automation", "sizeMb": 2.1 }
        ]
      }
    },
    ...
  }
}
```

### 3. Slimmer webhook storage

The webhook handler reduces storage by:

- **Skipping non-actionable events**: read receipts, message echoes, and other events that produce no queue jobs are not persisted.
- **Deduplicating retries**: Meta sometimes redelivers the same webhook. A deterministic hash of the payload prevents duplicate inserts.
- **Setting `workspaceId` at insert**: avoids a second UPDATE query that caused index bloat.
- **Rate-limiting signature-failure logs**: at most one `OperationalEvent` per 10 minutes for unauthenticated webhook attempts (scanner spam).

### 4. Quieter sweep logging

The comment polling reconciler (`recordSweep`) now:

- Logs errors unconditionally (level WARNING).
- Logs INFO only when comments were enqueued, and at most once per campaign per hour (instead of every 5 minutes).

This eliminates thousands of INFO rows per month from routine sweeps.

## Environment variables

Add these to `.env` (local) or your hosting environment (Vercel, Railway):

```bash
# Retention policy (days)
DB_RETENTION_WEBHOOK_EVENT_DAYS=7
DB_RETENTION_WEBHOOK_EVENT_WITH_MEDIA_DAYS=90
DB_RETENTION_OPERATIONAL_EVENT_INFO_DAYS=14
DB_RETENTION_OPERATIONAL_EVENT_ALL_DAYS=60
DB_RETENTION_LINK_CLICK_DAYS=180
DB_RETENTION_DM_LOG_DAYS=180
DB_RETENTION_DM_LOG_SCRUB_DAYS=30

# Size thresholds (MB)
DB_SIZE_WARNING_MB=350
DB_SIZE_ERROR_MB=450
```

All are optional; the values above are the defaults.

## Checking database size manually

Connect to your database and run:

```sql
-- Total database size
SELECT pg_size_pretty(pg_database_size(current_database())) AS total_size;

-- Top 10 tables by size
SELECT
  relname AS table_name,
  pg_size_pretty(pg_total_relation_size(C.oid)) AS total_size
FROM pg_class C
LEFT JOIN pg_namespace N ON (N.oid = C.relnamespace)
WHERE nspname = 'public'
ORDER BY pg_total_relation_size(C.oid) DESC
LIMIT 10;
```

Or just check `/api/health` in production.

## What to do at 350 MB (warning threshold)

1. **Check the health endpoint** to see which tables are largest.
2. **Verify the prune cron is running** by checking its logs in Vercel or Railway. If it has never run, check `CRON_SECRET` is set correctly.
3. **Reduce retention windows** if you don't need long history. For example, set `DB_RETENTION_WEBHOOK_EVENT_DAYS=3` and `DB_RETENTION_OPERATIONAL_EVENT_INFO_DAYS=7`.
4. **Run the prune cron manually** by calling `https://your-app.vercel.app/api/cron/prune` with `Authorization: Bearer <CRON_SECRET>`.
5. **Consider upgrading** to Supabase's paid tier (8 GB limit) if you need longer retention or have sustained high volume.

## What to do above 450 MB (error threshold)

At this point you are approaching the hard limit. **Act immediately:**

1. **Manually delete the oldest WebhookEvent rows** (they are the largest table):

   ```sql
   DELETE FROM "WebhookEvent"
   WHERE "createdAt" < NOW() - INTERVAL '3 days';
   ```

2. **Manually delete old OperationalEvent INFO rows**:

   ```sql
   DELETE FROM "OperationalEvent"
   WHERE level = 'INFO' AND "createdAt" < NOW() - INTERVAL '7 days';
   ```

3. **Run the prune cron immediately** (see step 4 above).
4. **Lower retention thresholds permanently** so it doesn't happen again.

## Backups

Supabase provides automatic daily backups on paid plans, but the free tier has **no automatic backups**. If you lose the database, you lose everything.

**Manual backup with `pg_dump` (recommended):**

```bash
# Full backup
pg_dump "postgresql://...@aws-0-us-east-1.pooler.supabase.com:6543/postgres" > backup.sql

# Schema only (for disaster recovery)
pg_dump --schema-only "postgresql://..." > schema.sql

# Data only (for analysis or migration)
pg_dump --data-only "postgresql://..." > data.sql
```

Schedule this weekly (or daily if you can't afford to lose a day's data) and store the backups off-site (S3, Dropbox, etc.).

## Risks and trade-offs

### DmLog scrubbing

After 30 days, `commentText` and `commenterName` are replaced with `[scrubbed]` and `null`. This protects user privacy and reduces storage, but it means:

- **The DM Logs page will show `[scrubbed]` for old comments.** If this breaks the UI, the scrubbing can be disabled by setting `DB_RETENTION_DM_LOG_SCRUB_DAYS` very high (e.g., `99999`), and only deletion at 180 days will apply.
- **Campaign reports that aggregate by commenter name will lose detail after 30 days.** If you need longer retention for reporting, increase `DB_RETENTION_DM_LOG_SCRUB_DAYS`.

The current implementation checks that scrubbing won't break the DM log display, but be aware of this trade-off.

### WebhookEvent retention and adMediaFor

The `adMediaFor` function scans WebhookEvent payloads for the last 90 days to find ad copies of a post (comments on a boosted post arrive with a different `media_id` but include `original_media_id` pointing back to the organic post).

**The prune cron keeps WebhookEvent rows containing `original_media_id` for 90 days, even though other rows are deleted after 7 days.** This ensures `adMediaFor` keeps working.

If you lower `DB_RETENTION_WEBHOOK_EVENT_WITH_MEDIA_DAYS` below 90, `adMediaFor` will miss older ad copies, and the polling reconciler may not find comments on ads older than your threshold. For most users this is fine (a 90-day ad is rare), but if you run long-running ad campaigns, keep the default.

## How effective is this?

A previous OpenReply instance grew to 2 GB and was unrecoverable. With these guardrails:

- **WebhookEvent** stops accumulating indefinitely (was the largest table).
- **OperationalEvent** doesn't fill with INFO sweep logs every 5 minutes.
- **LinkClick** and **DmLog** are capped at 6 months, which is more than enough for reporting.
- **Non-actionable webhooks** (scanner spam, read receipts) never hit the database.

Typical steady-state size for a single active workspace: **50–150 MB**, well under the 350 MB warning threshold.
