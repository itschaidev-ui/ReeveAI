-- CreateTable: Conversation
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Conversation_shop_updatedAt_idx" ON "Conversation"("shop", "updatedAt");

-- Add nullable conversationId to ChatMessage (existing rows get NULL).
-- Legacy rows are excluded from the sidebar; new messages always carry a value.
ALTER TABLE "ChatMessage" ADD COLUMN "conversationId" TEXT;

-- CreateIndex (skip if SQLite choke — composite index on conversationId + createdAt)
CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId", "createdAt");
