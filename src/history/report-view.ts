export type HistoryReportView = "simple" | "advanced";

export function parseHistoryReportView(value: string): HistoryReportView {
  if (value === "simple" || value === "advanced") return value;
  throw new Error("--view accepts: simple, advanced");
}

/** UK-style date/time: DD/MM/YYYY HH:mm (UTC, from ISO timestamps). */
export function formatUkDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getUTCFullYear());
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}
