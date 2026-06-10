import { describe, expect, it } from "vitest";
import { checkCommand } from "../src/guard.js";

const blocked = [
  "rm -rf /",
  "rm -rf /*",
  "sudo rm -fr /etc",
  "rm -r -f /var",
  "mkfs.ext4 /dev/sda1",
  "dd if=/dev/zero of=/dev/sda bs=1M",
  "echo junk > /dev/nvme0n1",
  "wipefs -a /dev/sda",
  "lvremove vg0",
  "shutdown -h now",
  "reboot",
  "init 0",
  "systemctl reboot",
  "systemctl stop sshd",
  "systemctl disable ssh",
  "psql -c 'DROP DATABASE sovereign'",
  "clickhouse-client -q 'TRUNCATE TABLE events_local'",
  "docker system prune -af",
  "docker volume rm adanalytics_pgdata",
  "docker compose -p adanalytics down -v",
  "docker compose down --volumes",
  "ufw disable",
  "iptables -F",
  "userdel admin",
  "kill -9 1",
  ":(){ :|:& };:",
];

const allowed = [
  "ls -la /opt/adpix",
  "docker compose -p adanalytics ps",
  "docker compose -p adanalytics down", // without -v: containers only, volumes survive
  "docker restart adanalytics-api-1",
  "rm -rf /opt/adpix/backups/tmp-test", // scoped delete, not a system dir
  "rm /tmp/foo.txt",
  "systemctl restart docker",
  "systemctl status ssh",
  "ufw status",
  "iptables -L",
  "git pull --ff-only origin main",
  "apt-get install -y htop",
  "df -h /",
  "grep -r 'drop_database_test' /opt/adpix/services", // mentions but doesn't run DROP
  "tail -f /var/log/syslog",
];

describe("run_command guard", () => {
  for (const cmd of blocked) {
    it(`blocks: ${cmd}`, () => {
      const v = checkCommand(cmd);
      expect(v.blocked, `expected BLOCK for: ${cmd}`).toBe(true);
      expect(v.reasons.length).toBeGreaterThan(0);
    });
  }
  for (const cmd of allowed) {
    it(`allows: ${cmd}`, () => {
      const v = checkCommand(cmd);
      expect(v.blocked, `expected ALLOW for: ${cmd} (matched: ${v.reasons.join("; ")})`).toBe(false);
    });
  }
});
