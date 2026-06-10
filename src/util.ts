/** Single-quote a string for POSIX shells. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Redact credential-looking values from command output before returning it to
 * the model/user. Catches KEY=value env lines (PASSWORD/SECRET/TOKEN/KEY/...)
 * and the human-readable "Password: x" line deploy.sh prints.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(
      /\b([A-Z0-9_]*(?:PASSWORD|PASSPHRASE|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY)[A-Z0-9_]*)=(\S+)/g,
      "$1=[redacted]"
    )
    .replace(/^(\s*Password:\s*)\S+.*$/gim, "$1[redacted — stored in .env on the server]");
}

/** Last n lines of a (possibly huge) output, with a truncation marker. */
export function lastLines(text: string, n: number): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= n) return text.trimEnd();
  return `… [${lines.length - n} earlier lines omitted] …\n` + lines.slice(-n).join("\n");
}

/** Render an ISO date difference in days (positive = in the future). */
export function daysUntil(dateMs: number, nowMs = Date.now()): number {
  return Math.floor((dateMs - nowMs) / 86_400_000);
}

export function isoDaysAgo(days: number, now = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
}

export function pct(num: number, den: number): string {
  if (den === 0) return "n/a";
  return ((num / den) * 100).toFixed(3) + "%";
}

/** Parse `docker compose ps --format json` output: JSON-lines (v2.21+) or a single array. */
export interface ComposeService {
  Name: string;
  Service: string;
  State: string;
  Status: string;
  Health?: string;
}

export function parseComposePs(out: string): ComposeService[] {
  const t = out.trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    try {
      return JSON.parse(t) as ComposeService[];
    } catch {
      return [];
    }
  }
  const rows: ComposeService[] = [];
  for (const line of t.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    try {
      rows.push(JSON.parse(l) as ComposeService);
    } catch {
      /* skip unparseable line */
    }
  }
  return rows;
}

/** Markdown-ish fixed table without relying on the client rendering pipes. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ");
  return [fmt(headers), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)].join("\n");
}
