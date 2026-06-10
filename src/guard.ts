/**
 * Guardrails for the raw `run_command` tool. Commands matching any pattern are
 * refused unless the call explicitly sets `confirm: true`. This is a safety
 * net against catastrophic one-liners, not a sandbox — the purpose-built tools
 * (adpix_restore, patch_system…) carry their own confirm flags.
 */

export interface GuardRule {
  pattern: RegExp;
  reason: string;
}

export const GUARD_RULES: GuardRule[] = [
  { pattern: /\brm\s+(?:-[a-zA-Z]+\s+)*\/\s*(?:$|\*)/, reason: "rm targeting the filesystem root" },
  {
    // The system dir root itself (rm -rf /etc, /var/, /opt/*) — deeper subpaths are operator judgment.
    pattern: /\brm\s+(?:--?[a-zA-Z-]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:-[a-zA-Z]+\s+)*["']?\/(?:bin|boot|dev|etc|home|lib|opt|root|srv|usr|var)\/?(?:$|[\s;&|*'"])/,
    reason: "recursive rm on a system directory",
  },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: "filesystem creation (wipes a device)" },
  { pattern: /\bdd\b[^|;&]*\bof=\/dev\//, reason: "dd writing to a block device" },
  { pattern: /[>]\s*\/dev\/(sd|vd|nvme|xvd|hd)[a-z0-9]*\b/, reason: "redirect onto a block device" },
  { pattern: /\b(wipefs|sgdisk|blkdiscard)\b/, reason: "partition/device wipe tool" },
  { pattern: /\b(lvremove|vgremove|pvremove)\b/, reason: "LVM volume destruction" },
  { pattern: /\b(shutdown|poweroff|halt)\b/, reason: "power state change" },
  { pattern: /\breboot\b/, reason: "reboot (use patch_system with autoReboot+confirm instead)" },
  { pattern: /\binit\s+[06]\b/, reason: "power state change via init" },
  { pattern: /\bsystemctl\s+(poweroff|halt|reboot|kexec)\b/, reason: "power state change via systemctl" },
  { pattern: /\bsystemctl\s+(stop|disable|mask)\s+(ssh|sshd)\b/, reason: "stopping sshd would lock you out" },
  { pattern: /\bdrop\s+(database|table|schema)\b/i, reason: "SQL DROP" },
  { pattern: /\btruncate\s+table\b/i, reason: "SQL TRUNCATE" },
  { pattern: /\bdocker\s+(system|volume|image|container|builder|network)\s+prune\b/, reason: "docker prune (can delete data volumes/images)" },
  { pattern: /\bdocker\s+volume\s+rm\b/, reason: "docker volume removal = database data loss" },
  { pattern: /\bdocker(\s+|-)compose\b[^|;&]*\bdown\b[^|;&]*(\s-v\b|--volumes\b)/, reason: "compose down -v deletes data volumes" },
  { pattern: /\bufw\s+(disable|reset)\b/, reason: "disabling the firewall" },
  { pattern: /\biptables\s+(-F\b|--flush)/, reason: "flushing firewall rules" },
  { pattern: /\bnft\s+flush\s+ruleset\b/, reason: "flushing nftables ruleset" },
  { pattern: /\b(userdel|deluser)\b/, reason: "user deletion" },
  { pattern: /\bch(mod|own)\b[^|;&]*\s-[a-zA-Z]*R[a-zA-Z]*\s[^|;&]*\s\/\s*(?:$|[;&|])/, reason: "recursive chmod/chown on /" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { pattern: /\bkill\s+(-\w+\s+)?1\b/, reason: "killing PID 1" },
];

export interface GuardVerdict {
  blocked: boolean;
  reasons: string[];
}

export function checkCommand(cmd: string): GuardVerdict {
  const reasons = GUARD_RULES.filter((r) => r.pattern.test(cmd)).map((r) => r.reason);
  return { blocked: reasons.length > 0, reasons };
}
