function normalizeListEntry(e: string): string {
  return e
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim()
    .toLowerCase();
}

function parseSuperadminEmails(): Set<string> {
  const raw = (process.env.SUPERADMIN_EMAILS ?? "").trim().replace(/^["']|["']$/g, "").trim();
  if (raw.length === 0) return new Set();
  return new Set(
    raw
      .split(",")
      .map(normalizeListEntry)
      .filter((e) => e.length > 0),
  );
}

export function isSuperadminEmail(email: string | null | undefined): boolean {
  if (email === null || email === undefined || email.length === 0) return false;
  const set = parseSuperadminEmails();
  if (set.size === 0) return false;
  return set.has(email.trim().toLowerCase());
}
