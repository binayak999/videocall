/** Basic chat safety — block common profanity and slurs (English). Extend / replace for production. */
const BLOCKED = new Set(
  [
    "fuck",
    "fucking",
    "shit",
    "bitch",
    "bastard",
    "asshole",
    "dick",
    "cock",
    "cunt",
    "pussy",
    "slut",
    "whore",
    "nigger",
    "nigga",
    "fag",
    "faggot",
    "retard",
    "rape",
    "porn",
  ].map(w => w.toLowerCase()),
);

function tokenizeForScan(text: string): string[] {
  const lower = text.toLowerCase();
  const parts = lower.split(/[^a-z0-9]+/g).filter(t => t.length > 0);
  return parts;
}

export function messageFailsChatPolicy(text: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Message is empty." };
  for (const t of tokenizeForScan(trimmed)) {
    if (BLOCKED.has(t)) return { ok: false, reason: "That language isn’t allowed in chat." };
    for (const bad of BLOCKED) {
      if (bad.length >= 4 && t.includes(bad)) return { ok: false, reason: "That language isn’t allowed in chat." };
    }
  }
  return { ok: true };
}
