export type ChatMessage = {
  id?: string
  senderId: string
  senderUserId?: string
  senderName?: string
  text: string
  createdAt: string
}

export type RosterEntry = { userName: string; userId: string; userEmail?: string }

export type JoinRequest = { requestId: string; name: string }

export type LiveCollabRequest = { requestId: string; name: string; userId: string }

export type VoteChoice = 'up' | 'down'

export type VoteSession = { sessionId: string; title: string; anonymous: boolean }

export type VoteBreakdownRow = { peerId: string; userName: string; choice: VoteChoice }
