import type { ZodRawShape } from "zod";
import type { Deps } from "../deps.js";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** One MCP tool: registration metadata + a handler that returns the text result. */
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: ZodRawShape;
  annotations?: ToolAnnotations;
  handler: (deps: Deps, args: Record<string, unknown>) => Promise<string>;
}
