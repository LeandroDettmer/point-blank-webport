// Prints the web login token for an account plus the SQL to provision it.
// Must match src/net/token.ts: base64(SHA-256("pbweb:" + user + ":" + pass)[0..16]).
// Usage: node server/tools/web-token.ts <username> <password>
import { createHash } from "node:crypto";

const [user, pass] = process.argv.slice(2);
if (!user || pass === undefined) {
  console.error("usage: node server/tools/web-token.ts <username> <password>");
  process.exit(1);
}
const token = createHash("sha256").update(`pbweb:${user}:${pass}`, "utf8").digest().subarray(0, 16).toString("base64");
console.log(token);
console.log(`UPDATE accounts SET token = '${token}' WHERE username = '${user.replace(/'/g, "''")}';`);
