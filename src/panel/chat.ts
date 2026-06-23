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
export interface ChatActor { role: Role; scopes: string[]; username: string }

const MODEL = () => process.env.ADPIX_CHAT_MODEL || "claude-sonnet-4-6";
const MAX_TOOL_ROUNDS = 6;

const SYSTEM =
  "You are the AdPix DevOps assistant, embedded in the AdPix Cloud control panel. You help the admin " +
  "understand and operate their fleet: servers, the AdPix Analytics and Tag Manager stacks, Postgres + " +
  "ClickHouse, the HA quorum (witness + nodes), deploys, backups, DNS, and security. You have READ-ONLY " +
  "tools — call them to investigate and answer with REAL data and concrete numbers; never invent values. " +
  "You CANNOT make changes from chat. When a change is warranted (restart, deploy/update, install, failover, " +
  "backup, scaling, security hardening, SMTP, etc.), name the exact panel action or tool + arguments the admin " +
  "should run and explain why — do not pretend to have done it. Be concise, precise, and operator-focused.";

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

export async function runChat(deps: Deps, opts: { messages: InMsg[]; actor: ChatActor; audit?: (tool: string, input: unknown) => void }): Promise<{ reply: string; steps: ChatStep[]; error?: string }> {
  const key = getAnthropicKey();
  if (!key) return { reply: "Chat is unavailable — set the Anthropic API key in Settings → AI assistant (use a key with a spend limit; chat costs API tokens).", steps: [], error: "no-api-key" };

  const cat = buildCatalog();
  const roCat = new Map<string, CatalogEntry>(cat.filter((c) => c.readOnly).map((c) => [c.name, c]));
  const tools = [...roCat.values()].map((c) => ({ name: c.name, description: c.description.slice(0, 1000), input_schema: inputSchema(c.params) }));

  // seed the conversation with the admin's text history (tool_use/tool_result blocks live only inside this loop)
  const messages: any[] = opts.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: String(m.content) }));
  const steps: ChatStep[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp = await callAnthropic(key, { model: MODEL(), max_tokens: 1600, system: SYSTEM, messages, tools });
    if (resp.error) return { reply: `Assistant error: ${resp.error}`, steps, error: resp.error };
    const blocks = resp.content || [];
    messages.push({ role: "assistant", content: blocks });
    const toolUses = blocks.filter((b: any) => b.type === "tool_use");
    if (!toolUses.length) {
      const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      return { reply: text || "(no reply)", steps };
    }
    const results: any[] = [];
    for (const tu of toolUses) {
      const tool = allTools.find((t) => t.name === tu.name);
      const c = roCat.get(tu.name);
      let out: string;
      if (!tool || !c) {
        out = `"${tu.name}" is not available from chat (read-only tools only — for changes, tell the admin which panel action to run).`;
      } else {
        const az = authorize(opts.actor.role, opts.actor.scopes, c, (tu.input as Record<string, unknown>) || {});
        if (!az.ok) {
          out = `Not permitted for ${opts.actor.username} (${opts.actor.role}): ${az.reason}`;
        } else {
          // Zod defaults aren't applied on direct handler calls — parse to fill them in.
          const parsed = z.object(tool.schema).safeParse(tu.input || {});
          try { out = String(await tool.handler(deps, (parsed.success ? parsed.data : tu.input || {}) as Record<string, unknown>)); }
          catch (e) { out = `error running ${tu.name}: ${(e as Error).message}`; }
        }
      }
      steps.push({ tool: tu.name, input: tu.input });
      opts.audit?.(tu.name, tu.input ?? {});
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out.slice(0, 6000) });
    }
    messages.push({ role: "user", content: results });
  }
  return { reply: "I ran several look-ups but didn't converge — try a more specific question.", steps };
}
