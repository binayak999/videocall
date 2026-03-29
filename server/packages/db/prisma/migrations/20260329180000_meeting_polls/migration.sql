-- CreateTable
CREATE TABLE "MeetingPoll" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "anonymous" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "MeetingPoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingPollVote" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "voterUserId" TEXT NOT NULL,
    "voterName" TEXT NOT NULL,
    "choice" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingPollVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MeetingPoll_meetingId_createdAt_idx" ON "MeetingPoll"("meetingId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingPollVote_pollId_voterUserId_key" ON "MeetingPollVote"("pollId", "voterUserId");

-- AddForeignKey
ALTER TABLE "MeetingPoll" ADD CONSTRAINT "MeetingPoll_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingPollVote" ADD CONSTRAINT "MeetingPollVote_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "MeetingPoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;
