import { createHash, randomBytes } from "node:crypto";

// 24 raw bytes -> base64 is exactly 32 chars with no padding. The client base64-decodes it, sends the raw
// bytes in LOGIN (1281) and the server re-encodes them with base64: that string is what login/register
// return and what the client echoes back.
export function generateToken(): string {
  return randomBytes(24).toString("base64");
}

const STORED_PREFIX = "h:";

/**
 * What accounts.token holds: "h:" + 30 chars of base64url(SHA-256(token)) = 32 chars (the column is varchar(32)).
 * A leaked accounts table does not log anyone in. A legacy row still holds the plaintext token: db.accountByToken
 * matches both forms and rewrites the plaintext one (lazy migration).
 */
export const storedToken = (token: string): string => STORED_PREFIX + createHash("sha256").update(token).digest("base64url").slice(0, 30);
export const isStoredToken = (v: string): boolean => v.startsWith(STORED_PREFIX);
