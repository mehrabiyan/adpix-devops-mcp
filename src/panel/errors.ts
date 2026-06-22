/**
 * Classify SSH/Node connection errors into a stable category + an operator-friendly message,
 * so the panel never surfaces a raw stack/errno. Used by diagnosis, the add-server flow, and
 * the endpoint catches.
 */
export type ErrKind = "auth" | "refused" | "timeout" | "dns" | "hostkey" | "keymissing" | "unknown";

export function classifyError(e: unknown): { kind: ErrKind; message: string } {
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.toLowerCase();
  if (/host key|known_hosts|fingerprint|host-key/.test(m)) return { kind: "hostkey", message: raw };
  if (/authentication methods failed|auth.*fail|permission denied|password.*(incorrect|rejected)|keyboard-interactive/.test(m))
    return { kind: "auth", message: "SSH authentication failed — wrong key or password, or that user isn't permitted." };
  if (/econnrefused|connection refused/.test(m)) return { kind: "refused", message: "Connection refused — SSH isn't listening on that host:port (or a firewall blocks it)." };
  if (/etimedout|timed out|timeout|ehostunreach| enetunreach/.test(m)) return { kind: "timeout", message: "Timed out reaching the host — check the IP, the SSH port, and the network/firewall." };
  if (/enotfound|eai_again|getaddrinfo/.test(m)) return { kind: "dns", message: "Host not found — check the hostname or IP address." };
  if (/private key not found|no ssh credentials/.test(m)) return { kind: "keymissing", message: raw };
  return { kind: "unknown", message: raw };
}
