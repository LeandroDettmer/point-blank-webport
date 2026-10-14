// The account API lives in the same process as the PB WebSocket endpoints (server/src/web), port 8090.
// Production build: VITE_API_URL = the server's https origin (Cloud Run), the page itself being
// on another origin (Firebase Hosting), which the server's CORS list has to allow.
const ACCOUNT_API_PORT = 8090;
/** import.meta.env is undefined outside Vite (the Node tests) */
const API_URL = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_URL;

export interface AccountApiResult {
  token: string; // base64 of the raw token bytes the game server expects
  playerId: string;
  nickname: string;
}

export class AccountApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function accountApiUrl(path: string): string {
  return API_URL ? `${API_URL.replace(/\/+$/, "")}${path}` : `http://${location.hostname}:${ACCOUNT_API_PORT}${path}`;
}

async function postCredentials(path: string, username: string, password: string): Promise<AccountApiResult> {
  const res = await fetch(accountApiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  const body = await res.json().catch(() => ({}) as { error?: string });
  if (!res.ok) {
    throw new AccountApiError(res.status, (body as { error?: string }).error ?? `request failed (${res.status})`);
  }
  return body as AccountApiResult;
}

export function registerAccount(username: string, password: string): Promise<AccountApiResult> {
  return postCredentials("/api/register", username, password);
}

export function loginAccount(username: string, password: string): Promise<AccountApiResult> {
  return postCredentials("/api/login", username, password);
}

const SESSION_KEY = "pb.session";

/** Dev convenience: keep the last login (base64 token + nickname) in sessionStorage for auto-login. */
export function saveSession(res: AccountApiResult): void {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(res)); } catch { /* storage blocked */ }
}

export function loadSession(): AccountApiResult | null {
  try {
    const r = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
    return r && typeof r.token === "string" && typeof r.nickname === "string" ? (r as AccountApiResult) : null;
  } catch { return null; }
}

export function clearSession(): void {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ }
}

/** Decode the API's base64 token string into the raw bytes the server expects on the wire. */
export function tokenToBytes(base64Token: string): Uint8Array {
  const binary = atob(base64Token);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
