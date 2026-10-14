export async function assetExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    // Vite's SPA fallback answers missing files with 200 + index.html.
    const type = res.headers.get("content-type") ?? "";
    return res.ok && !type.includes("text/html");
  } catch {
    return false;
  }
}
