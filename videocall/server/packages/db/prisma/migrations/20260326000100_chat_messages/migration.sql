CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatMessage_meetingId_createdAt_idx" ON "ChatMessage"("meetingId", "createdAt");

ALTER TABLE "ChatMessage"
ADD CONSTRAINT "ChatMessage_meetingId_fkey"
FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
