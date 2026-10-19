import { MCP_APP_RESOURCE_SCHEME } from "@t3tools/shared/mcpApp";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Predicate from "effect/Predicate";

/**
 * MCP Apps (SEP-1865) for Claude threads.
 *
 * Claude Code dials the MCP servers itself, so every request goes through its
 * control channel: `mcp_status` lists a tool's UI metadata, `mcp_read_resource`
 * reads its `ui://` document and `mcp_call` runs the app's own tool calls
 * without a model turn.
 */

/** The CLI turns every character outside `[a-zA-Z0-9_-]` in a server or tool name into `_`. */
export const normalizeClaudeMcpName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/gu, "_");

/** Splits `mcp__<server>__<tool>`; anything else is not an MCP tool call. */
export function parseClaudeMcpToolName(
  toolName: string,
): { readonly server: string; readonly tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/u.exec(toolName);
  return match === null ? undefined : { server: match[1]!, tool: match[2]! };
}

export const claudeMcpToolName = (server: string, tool: string) =>
  `mcp__${normalizeClaudeMcpName(server)}__${normalizeClaudeMcpName(tool)}`;

/** One server as `mcpServerStatus()` reports it; only the members MCP Apps read. */
export interface ClaudeMcpServerStatusLike {
  readonly name: string;
  readonly status?: string;
  readonly tools?: ReadonlyArray<ClaudeMcpToolStatusLike>;
}

export interface ClaudeMcpToolStatusLike {
  readonly name: string;
  readonly annotations?: unknown;
  readonly _meta?: unknown;
  readonly ui?: unknown;
}

/**
 * The tool's UI members. The CLI reports them under `_meta` (`ui`, and the
 * deprecated flat `ui/resourceUri`); a top-level `ui` is read too.
 */
function claudeMcpToolUiMeta(tool: ClaudeMcpToolStatusLike): Record<string, unknown> | undefined {
  const meta = Predicate.isObject(tool._meta) ? tool._meta : undefined;
  const ui = Predicate.isObject(meta?.ui)
    ? meta.ui
    : Predicate.isObject(tool.ui)
      ? tool.ui
      : undefined;
  const flat = meta?.["ui/resourceUri"];
  if (ui === undefined && typeof flat !== "string") return undefined;
  return {
    ...(ui === undefined ? {} : { ui }),
    ...(typeof flat === "string" ? { "ui/resourceUri": flat } : {}),
  };
}

export function claudeMcpAppResourceUri(tool: ClaudeMcpToolStatusLike): string | undefined {
  const meta = claudeMcpToolUiMeta(tool);
  const ui = meta?.ui;
  const uri = Predicate.isObject(ui) ? ui.resourceUri : meta?.["ui/resourceUri"];
  return typeof uri === "string" && uri.startsWith(MCP_APP_RESOURCE_SCHEME) ? uri : undefined;
}

/** The CLI names annotations without the MCP `Hint` suffix (`readOnly`). */
function claudeMcpToolAnnotations(annotations: unknown): Record<string, unknown> | undefined {
  if (!Predicate.isObject(annotations)) return undefined;
  const out: Record<string, unknown> = { ...annotations };
  for (const key of ["readOnly", "destructive", "idempotent", "openWorld"] as const) {
    if (typeof annotations[key] === "boolean" && out[`${key}Hint`] === undefined) {
      out[`${key}Hint`] = annotations[key];
    }
  }
  return out;
}

export function claudeMcpToolForApps(
  tool: ClaudeMcpToolStatusLike,
): ProviderAdapter.ProviderAdapterV2McpTool {
  const meta = claudeMcpToolUiMeta(tool);
  const annotations = claudeMcpToolAnnotations(tool.annotations);
  return {
    name: tool.name,
    ...(meta === undefined ? {} : { _meta: meta }),
    ...(annotations === undefined ? {} : { annotations }),
  };
}

/**
 * Resolves a tool call's normalized `mcp__<server>__<tool>` name to the server
 * and tool as configured, which the app and resource reads need.
 */
export function resolveClaudeMcpTool(
  statuses: ReadonlyArray<ClaudeMcpServerStatusLike>,
  toolName: string,
):
  | { readonly server: ClaudeMcpServerStatusLike; readonly tool: ClaudeMcpToolStatusLike }
  | undefined {
  const parts = parseClaudeMcpToolName(toolName);
  if (parts === undefined) return undefined;
  for (const server of statuses) {
    if (normalizeClaudeMcpName(server.name) !== parts.server) continue;
    const tool = server.tools?.find(
      (candidate) => normalizeClaudeMcpName(candidate.name) === parts.tool,
    );
    if (tool !== undefined) return { server, tool };
  }
  return undefined;
}

/**
 * An MCP `CallToolResult` from what the CLI hands back: `mcp_call` with
 * `result_not_for_model` answers the server's own blocks, while a model
 * turn's `tool_use_result` carries `content` as one string.
 */
export function claudeMcpCallToolResult(
  value: unknown,
): ProviderAdapter.ProviderAdapterV2McpCallToolResult | undefined {
  if (!Predicate.isObject(value)) return undefined;
  const content =
    typeof value.content === "string"
      ? [{ type: "text", text: value.content }]
      : Array.isArray(value.content)
        ? value.content
        : undefined;
  if (content === undefined) return undefined;
  return {
    content,
    ...(value.structuredContent === undefined
      ? {}
      : { structuredContent: value.structuredContent }),
    ...(value.isError === true ? { isError: true } : {}),
    ...(value._meta === undefined ? {} : { _meta: value._meta }),
  };
}
