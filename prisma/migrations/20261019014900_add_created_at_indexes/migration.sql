-- CreateIndex
CREATE INDEX IF NOT EXISTS "WebhookEvent_createdAt_idx" ON "WebhookEvent"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DmLog_createdAt_idx" ON "DmLog"("createdAt");
