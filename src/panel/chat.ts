import { z } from "zod";
import type { Deps } from "../deps.js";
import { allTools } from "../tools/index.js";
import { buildCatalog, type CatalogEntry } from "./catalog.js";
import type { Role } from "./admins.js";
import { authorize } from "./rbac.js";
import { getAnthropicKey } from "./secrets.js";

/**
 * Chat gateway. A server-side tool-use loop on the Anthropic Messages API (raw fetch — no SDK
 * dependency; ANTHROPIC_API_KEY from the MCP env). The model is given the panel's READ-ONLY tools
 * and runs them automatically to answer questions with real fleet data. It is NEVER given
 * destructive tools — for any change it must tell the admin which panel action to run. Each
 * read-only tool call is authorized against the asking admin's role/scopes.
 */

interface InMsg { role: "user" | "assistant"; content: string }
interface ChatStep { tool: string; input: unknown }
export interface ProposedAction { tool: string; title: string; input: Record<string, unknown>; destructive: boolean }
export interface ChatActor { role: Role; scopes: string[]; username: string }

/** Short human label for a proposed action button: tool title + the key target arg(s). */
function actionTitle(c: CatalogEntry, input: Record<string, unknown>): string {
  const keys = ["server", "cluster", "service", "stack", "engine", "mode", "name"];
  const bits = keys.filter((k) => input[k] != null && input[k] !== "").map((k) => `${k}=${input[k]}`);
  return bits.length ? `${c.title} · ${bits.join(" ")}` : c.title;
}

const MODEL = () => process.env.ADPIX_CHAT_MODEL || "claude-sonnet-4-6";
const MAX_TOOL_ROUNDS = 6;

const SYSTEM =
  "You are the AdPix DevOps assistant, embedded in the AdPix Cloud control panel. You help the admin " +
  "understand and operate their fleet: servers, the AdPix Analytics and Tag Manager stacks, Postgres + " +
  "ClickHouse, the HA quorum (witness + nodes), deploys, backups, DNS, and security.\n" +
  "You have the panel's full toolset. READ-ONLY tools (status/health/list/metrics/diagnostics) run " +
  "immediately — call them freely to investigate and answer with REAL data and concrete numbers; never " +
  "invent values.\n" +
  "Tools that CHANGE things (restart, deploy/update, install, failover, backup, scaling, hardening, etc.) are " +
  "NOT executed when you call them — instead they are surfaced to the admin as a one-click confirm button with " +
  "a typed confirmation. So: when an action is warranted, CALL the tool with the exact arguments (this creates " +
  "the button) and, in your text, tell the admin what you are proposing and why. Never claim a change has been " +
  "applied — it only runs after the admin clicks and confirms. Be concise, precise, and operator-focused.";

function inputSchema(params: unknown): Record<string, unknown> {
  const p = (params && typeof params === "object" ? { ...(params as Record<string, unknown>) } : {}) as Record<string, unknown>;
  delete p.$schema; // Anthropic input_schema doesn't want it
  if (!p.type) p.type = "object";
  if (!p.properties) p.properties = {};
  return p;
}

async function callAnthropic(key: string, body: unknown): Promise<{ content?: any[]; error?: string }> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return { error: j?.error?.message || `Anthropic HTTP ${r.status}` };
    return { content: j.content || [] };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function runChat(deps: Deps, opts: { messages: InMsg[]; actor: ChatActor; audit?: (tool: string, input: unknown) => void }): Promise<{ reply: string; steps: ChatStep[]; proposed: ProposedAction[]; error?: string }> {
  const key = getAnthropicKey();
  if (!key) return { reply: "Chat is unavailable — set the Anthropic API key in Settings → AI assistant (use a key with a spend limit; chat costs API tokens).", steps: [], proposed: [], error: "no-api-key" };

  // The model gets the FULL toolset: read-only tools run immediately; change-making tools are not
  // executed here — they become confirm buttons the admin clicks (the normal destructive flow).
  const cat = new Map<string, CatalogEntry>(buildCatalog().map((c) => [c.name, c]));
  const tools = [...cat.values()].map((c) => ({ name: c.name, description: c.description.slice(0, 1000), input_schema: inputSchema(c.params) }));

  // seed the conversation with the admin's text history (tool_use/tool_result blocks live only inside this loop)
  const messages: any[] = opts.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: String(m.content) }));
  const steps: ChatStep[] = [];
  const proposed: ProposedAction[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp = await callAnthropic(key, { model: MODEL(), max_tokens: 1600, system: SYSTEM, messages, tools });
    if (resp.error) return { reply: `Assistant error: ${resp.error}`, steps, proposed, error: resp.error };
    const blocks = resp.content || [];
    messages.push({ role: "assistant", content: blocks });
    const toolUses = blocks.filter((b: any) => b.type === "tool_use");
    if (!toolUses.length) {
      const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      return { reply: text || "(no reply)", steps, proposed };
    }
    const results: any[] = [];
    for (const tu of toolUses) {
      const tool = allTools.find((t) => t.name === tu.name);
      const c = cat.get(tu.name);
      const input = (tu.input as Record<string, unknown>) || {};
      let out: string;
      if (!tool || !c) {
        out = `"${tu.name}" is not a known tool.`;
      } else {
        const az = authorize(opts.actor.role, opts.actor.scopes, c, input);
        if (!az.ok) {
          out = `Not permitted for ${opts.actor.username} (${opts.actor.role}): ${az.reason}. Tell the admin this needs a higher role.`;
        } else if (c.readOnly) {
          steps.push({ tool: tu.name, input });
          opts.audit?.(tu.name, input);
          // Zod defaults aren't applied on direct handler calls — parse to fill them in.
          const parsed = z.object(tool.schema).safeParse(input);
          try { out = String(await tool.handler(deps, (parsed.success ? parsed.data : input) as Record<string, unknown>)); }
          catch (e) { out = `error running ${tu.name}: ${(e as Error).message}`; }
        } else {
          // change-making tool → surface as a confirm button; do NOT execute here.
          proposed.push({ tool: tu.name, title: actionTitle(c, input), input, destructive: c.destructive });
          out = `PROPOSED to the admin as a confirm button — it has NOT run yet and will only execute after the admin clicks and confirms. Do not assume it succeeded; tell the admin what you're proposing and why.`;
        }
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out.slice(0, 6000) });
    }
    messages.push({ role: "user", content: results });
  }
  return { reply: "I ran several look-ups but didn't converge — try a more specific question.", steps, proposed };
}
