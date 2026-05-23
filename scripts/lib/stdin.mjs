const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB sanity cap

export function readStdin(maxBytes = DEFAULT_MAX_BYTES) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let buf = "";
    let truncated = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (truncated) return;
      buf += chunk;
      if (buf.length > maxBytes) {
        truncated = true;
        buf = buf.slice(0, maxBytes);
        try { process.stdin.pause(); } catch { /* best effort */ }
        resolve(buf);
      }
    });
    process.stdin.on("end", () => {
      if (!truncated) resolve(buf);
    });
    process.stdin.on("error", () => {
      if (!truncated) resolve(buf);
    });
  });
}
