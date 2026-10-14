import type { PoolClient } from "pg";
import { pool } from "../../db.ts";
import { generateToken, storedToken } from "./token.ts";
import { hashPassword, verifyPassword, needsRehash } from "./password.ts";
import { isReservedNick } from "./validation.ts";

export class AccountApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface LoginResult {
  token: string;
  playerId: string;
  nickname: string;
}

function randomAccountsPassword(): string {
  // accounts.password is only length-checked by the game server (Test mode
  // skips even that); the real credential lives in account_api_credentials.
  return generateToken().slice(0, 12);
}

export async function registerAccount(username: string, password: string): Promise<LoginResult> {
  if (isReservedNick(username)) throw new AccountApiError(400, "username not allowed"); // the nickname starts as the username
  const passwordHash = await hashPassword(password);
  const token = generateToken();
  const accountsPassword = randomAccountsPassword();
  const email = `${username}@webclient.local`;

  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    const existingCred = await client.query(
      "SELECT 1 FROM account_api_credentials WHERE username = $1",
      [username],
    );
    if (existingCred.rowCount) {
      throw new AccountApiError(409, "username already registered");
    }

    const existingAccount = await client.query(
      "SELECT 1 FROM accounts WHERE username = $1",
      [username],
    );
    if (existingAccount.rowCount) {
      throw new AccountApiError(409, "username already registered");
    }

    await client.query(
      "INSERT INTO account_api_credentials (username, password_hash) VALUES ($1, $2)",
      [username, passwordHash],
    );

    const inserted = await client.query(
      `INSERT INTO accounts (username, password, nickname, email, token, gold, cash, access_level)
       VALUES ($1, $2, $3, $4, $5, 100000, 80000, 0)
       RETURNING player_id, nickname`,
      [username, accountsPassword, username, email, storedToken(token)],
    );

    await client.query("COMMIT");

    const row = inserted.rows[0];
    return { token, playerId: String(row.player_id), nickname: row.nickname };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function loginAccount(username: string, password: string): Promise<LoginResult> {
  const cred = await pool.query(
    "SELECT password_hash FROM account_api_credentials WHERE username = $1",
    [username],
  );
  if (cred.rowCount === 0) {
    throw new AccountApiError(401, "invalid username or password");
  }

  const ok = await verifyPassword(password, cred.rows[0].password_hash);
  if (!ok) {
    throw new AccountApiError(401, "invalid username or password");
  }

  if (needsRehash(cred.rows[0].password_hash)) {
    await pool.query(
      "UPDATE account_api_credentials SET password_hash = $1, updated_at = now() WHERE username = $2",
      [await hashPassword(password), username],
    );
  }

  const token = generateToken();
  const updated = await pool.query(
    `UPDATE accounts SET token = $1 WHERE username = $2 RETURNING player_id, nickname`,
    [storedToken(token), username],
  );
  if (updated.rowCount === 0) {
    // credentials row exists but the accounts row is gone (shouldn't happen
    // outside manual DB edits) - surface as an auth failure, not a 500.
    throw new AccountApiError(401, "invalid username or password");
  }

  const row = updated.rows[0];
  return { token, playerId: String(row.player_id), nickname: row.nickname };
}
