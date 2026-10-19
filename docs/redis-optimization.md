# Redis Command Budget Optimization

## Problem

Upstash's free Redis tier allows only 500,000 commands per month (~11 commands/min average). The OpenReply always-on worker, using BullMQ for job queue processing and a heartbeat health check, was exhausting this limit with no real traffic due to idle polling.

## Sources of Idle Redis Commands

### Before Optimization

1. **BullMQ Worker Polling** (`drainDelay` = 5s default)
   - Worker checks for new jobs every 5 seconds when idle
   - ~12 commands/min × 43,200 min/month = **~518,400 commands/month**

2. **BullMQ Stalled Job Checks** (`stalledInterval` = 30s default)
   - Worker checks for stalled jobs every 30 seconds
   - ~2 commands/min × 43,200 min/month = **~86,400 commands/month**

3. **Worker Heartbeat** (`HEARTBEAT_INTERVAL_MS` = 30s)
   - Health check writes heartbeat every 30 seconds
   - ~2 commands/min × 43,200 min/month = **~86,400 commands/month**

**Total Idle Usage: ~691,200 commands/month** (exceeds 500k limit)

### After Optimization

1. **BullMQ Worker Polling** (`drainDelay` = 60s)
   - ~1 command/min × 43,200 min/month = **~43,200 commands/month**

2. **BullMQ Stalled Job Checks** (`stalledInterval` = 5 min)
   - ~0.2 commands/min × 43,200 min/month = **~8,640 commands/month**

3. **Worker Heartbeat** (`HEARTBEAT_INTERVAL_MS` = 5 min)
   - ~0.2 commands/min × 43,200 min/month = **~8,640 commands/month**

**Total Idle Usage: ~60,480 commands/month** (well under 150k target, 12% of limit)

## Environment Variables

All settings are now configurable via environment variables with safe defaults for low-traffic deployments:

### Worker Heartbeat Settings

| Variable | Default | Description |
| --- | --- | --- |
| `WORKER_HEARTBEAT_INTERVAL_MS` | `300000` (5 min) | How often the worker writes its health heartbeat to Redis |
| `WORKER_HEARTBEAT_TTL_SECONDS` | `720` (12 min) | How long the heartbeat key lives in Redis; health check treats worker as healthy if heartbeat age < this value |

### BullMQ Worker Settings

| Variable | Default | Description |
| --- | --- | --- |
| `BULLMQ_DRAIN_DELAY_MS` | `60000` (60s) | How long the worker waits when idle before checking for new jobs. Higher = fewer Redis commands, slightly higher DM latency when idle |
| `BULLMQ_STALLED_INTERVAL_MS` | `300000` (5 min) | How often the worker checks for stalled jobs. Higher = fewer Redis commands, slower stalled job recovery |
| `BULLMQ_LOCK_DURATION_MS` | `30000` (30s) | How long a job lock lasts before renewal. Keep this reasonable to allow job recovery if worker crashes |
| `BULLMQ_MAX_STALLED_COUNT` | `2` | How many times a job can be marked as stalled before it's permanently failed |

## Latency Trade-offs

The optimizations trade slightly higher latency for dramatically lower Redis usage:

- **Comment to DM latency**: With `drainDelay` at 60s, a new job may wait up to 60 seconds before being picked up (vs 5s before). This is acceptable since Instagram webhooks are already best-effort and the polling reconciler runs every 5 minutes as a safety net.

- **Stalled job recovery**: With `stalledInterval` at 5 minutes, a job won't be marked as stalled until 5 minutes after its lock expires (vs 30s before). Since stalled jobs are rare (worker crash during processing), this is acceptable.

- **Health check**: The worker is considered healthy if its heartbeat is less than 12 minutes old (vs 2 minutes before). This allows 2-3 missed heartbeat intervals before triggering an alert.

## Behavior Guarantees

Despite the reduced polling frequency, the system remains correct:

- ✅ **No lost jobs**: BullMQ's blocking drain still picks up new jobs immediately when they arrive
- ✅ **Prompt processing**: New comments are processed within ~60 seconds (vs ~5s before)
- ✅ **Reliable retries**: Failed jobs retry with the same backoff strategy
- ✅ **Polling reconciler unchanged**: Still sweeps every 5 minutes for missed comments
- ✅ **Rate limiting intact**: Per-account DM rate limits still enforced

## Monitoring

Check `/api/health` to verify the worker is running and healthy:

```json
{
  "status": "ok",
  "checks": {
    "worker": {
      "healthy": true,
      "heartbeat": {
        "status": "running",
        "pid": 1234,
        "checkedAt": "2024-01-01T00:00:00.000Z"
      },
      "ageMs": 120000
    }
  }
}
```

If `worker.healthy` is false and `ageMs` exceeds 720,000ms (12 minutes), the worker may have crashed or lost connectivity to Redis.

## Further Tuning

For high-traffic deployments where Redis command budget is not a concern, you can restore the original aggressive polling:

```bash
# Original aggressive settings (high Redis usage)
WORKER_HEARTBEAT_INTERVAL_MS=30000       # 30 seconds
WORKER_HEARTBEAT_TTL_SECONDS=120         # 2 minutes
BULLMQ_DRAIN_DELAY_MS=5000               # 5 seconds
BULLMQ_STALLED_INTERVAL_MS=30000         # 30 seconds
```

This brings idle latency back to ~5 seconds at the cost of ~691k Redis commands/month.
