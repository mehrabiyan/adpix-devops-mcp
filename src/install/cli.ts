#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { realDeps } from "../deps.js";
import { buildSteps } from "./steps.js";
import { runPlan, planDryRun, type InstallContext } from "./core.js";
import { loadJournal } from "./journal.js";
import { defaultAnswers, validateAnswers, secretsFromEnv, type InstallAnswers } from "./answers.js";
import { uninstall, revokeKeys, rollback } from "./lifecycle.js";

/**
 * The installer entrypoint the bash bootstrap (scripts/adpix-setup.sh) and the web wizard
 * both drive. `--answers-file <json>` is the non-interactive path; the front-ends build
 * the same InstallAnswers and invoke this. Secrets arrive via env, never argv.
 */

export type CliMode = "install" | "dry-run" | "uninstall" | "revoke" | "rollback" | "help";
export interface CliArgs {
  mode: CliMode;
  answersFile?: string;
  purge: boolean;
  force: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { mode: "install", purge: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--dry-run") a.mode = "dry-run";
    else if (x === "--uninstall") a.mode = "uninstall";
    else if (x === "--revoke") a.mode = "revoke";
    else if (x === "--rollback") a.mode = "rollback";
    else if (x === "--help" || x === "-h") a.mode = "help";
    else if (x === "--purge") a.purge = true;
    else if (x === "--force") a.force = true;
    else if (x === "--answers" || x === "--answers-file") a.answersFile = argv[++i];
  }
  return a;
}

const HELP = `adpix-devops-mcp installer
  (default)            run/converge the install from --answers-file (or defaults)
  --dry-run            show what WOULD change, mutate nothing
  --uninstall [--purge]  remove the service (--purge also drops state, registry, SSH identity)
  --revoke             strip the MCP key from every registered target's authorized_keys
  --rollback           roll the service back to the previous commit + rebuild + restart
  --answers-file <json>  InstallAnswers JSON (secrets come from env, never here)
  --force              re-apply even already-satisfied steps`;

function mcpPubkeyPath(): string {
  return path.join(process.env.ADPIX_DEVOPS_HOME || "/var/lib/adpix-devops-mcp", ".ssh/id_ed25519.pub");
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.mode === "help") { console.log(HELP); return 0; }
  const deps = realDeps;

  if (args.mode === "uninstall") { console.log(await uninstall(deps, { purge: args.purge })); return 0; }
  if (args.mode === "rollback") { console.log(await rollback(deps)); return 0; }
  if (args.mode === "revoke") {
    let pub = "";
    try { pub = fs.readFileSync(mcpPubkeyPath(), "utf8").trim(); } catch { console.error(`MCP pubkey not found at ${mcpPubkeyPath()}`); return 2; }
    console.log(await revokeKeys(deps, pub));
    return 0;
  }

  const answers: InstallAnswers = args.answersFile
    ? (JSON.parse(fs.readFileSync(args.answersFile, "utf8")) as InstallAnswers)
    : defaultAnswers();
  const v = validateAnswers(answers);
  if (!v.ok) { console.error("Invalid answers:\n" + v.errors.map((e) => "  - " + e).join("\n")); return 2; }

  const ctx: InstallContext = {
    answers, secrets: secretsFromEnv(), deps, journal: loadJournal(),
    log: (m) => console.error(m), force: args.force, runtime: {},
  };

  if (args.mode === "dry-run") {
    const plan = await planDryRun(buildSteps(), ctx);
    console.log("# Install plan (dry-run — nothing changed)");
    console.log(plan.map((p) => `  [${p.done ? "ok  " : "APPLY"}] ${p.title}`).join("\n"));
    return 0;
  }

  const out = await runPlan(buildSteps(), ctx);
  if (ctx.runtime.emitDns) console.log("\n" + ctx.runtime.emitDns);
  if (ctx.runtime.emitConnect) console.log("\n" + ctx.runtime.emitConnect);
  if (ctx.runtime.emitVerify) console.log("\n" + ctx.runtime.emitVerify);
  return out.aborted ? 1 : 0;
}

// Run only when executed directly (so tests can import parseArgs/run without side effects).
const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry && (entry.endsWith("install/cli.js") || entry.endsWith("install/cli.ts"))) {
  run(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
}
