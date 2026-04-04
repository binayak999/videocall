CREATE TABLE "MeetingCaption" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "speakerUserId" TEXT NOT NULL,
    "speakerName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingCaption_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MeetingCaption_meetingId_createdAt_idx" ON "MeetingCaption"("meetingId", "createdAt");

ALTER TABLE "MeetingCaption"
ADD CONSTRAINT "MeetingCaption_meetingId_fkey"
FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
