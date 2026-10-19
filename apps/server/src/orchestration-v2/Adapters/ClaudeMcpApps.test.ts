import { assert, describe, it } from "@effect/vitest";

import {
  claudeMcpAppResourceUri,
  claudeMcpCallToolResult,
  claudeMcpToolForApps,
  claudeMcpToolName,
  parseClaudeMcpToolName,
  resolveClaudeMcpTool,
} from "./ClaudeMcpApps.ts";

describe("ClaudeMcpApps", () => {
  it("normalizes names the way the CLI does", () => {
    assert.equal(claudeMcpToolName("bits-and-bolts", "cad.view"), "mcp__bits-and-bolts__cad_view");
    assert.equal(claudeMcpToolName("my server", "a/b"), "mcp__my_server__a_b");
    assert.deepEqual(parseClaudeMcpToolName("mcp__bits-and-bolts__cad_view"), {
      server: "bits-and-bolts",
      tool: "cad_view",
    });
    assert.isUndefined(parseClaudeMcpToolName("Read"));
  });

  it("resolves a normalized call to the configured server and tool", () => {
    const statuses = [
      { name: "other", tools: [{ name: "cad.view" }] },
      { name: "bits-and-bolts", tools: [{ name: "cad.view" }, { name: "cad.search" }] },
    ];
    const resolved = resolveClaudeMcpTool(statuses, "mcp__bits-and-bolts__cad_view");
    assert.equal(resolved?.server.name, "bits-and-bolts");
    assert.equal(resolved?.tool.name, "cad.view");
    assert.isUndefined(resolveClaudeMcpTool(statuses, "mcp__bits-and-bolts__cad_missing"));
    assert.isUndefined(resolveClaudeMcpTool(statuses, "Bash"));
  });

  it("reads the ui:// resource from _meta, a top-level ui, or the flat key", () => {
    const uri = "ui://app/view";
    assert.equal(claudeMcpAppResourceUri({ name: "a", _meta: { ui: { resourceUri: uri } } }), uri);
    assert.equal(claudeMcpAppResourceUri({ name: "a", ui: { resourceUri: uri } }), uri);
    assert.equal(claudeMcpAppResourceUri({ name: "a", _meta: { "ui/resourceUri": uri } }), uri);
    assert.isUndefined(
      claudeMcpAppResourceUri({ name: "a", _meta: { ui: { resourceUri: "https://x" } } }),
    );
    assert.isUndefined(
      claudeMcpAppResourceUri({ name: "a", _meta: { ui: { visibility: ["app"] } } }),
    );
    assert.isUndefined(claudeMcpAppResourceUri({ name: "a" }));
  });

  it("keeps app visibility and maps annotations to their MCP names", () => {
    const tool = claudeMcpToolForApps({
      name: "cad.importPart",
      annotations: { readOnly: false, destructive: true },
      _meta: { ui: { visibility: ["app"] }, other: "withheld upstream" },
    });
    assert.deepEqual(tool, {
      name: "cad.importPart",
      inputSchema: { type: "object" },
      _meta: { ui: { visibility: ["app"] } },
      annotations: {
        readOnly: false,
        destructive: true,
        readOnlyHint: false,
        destructiveHint: true,
      },
    });
    assert.deepEqual(claudeMcpToolForApps({ name: "plain" }), {
      name: "plain",
      inputSchema: { type: "object" },
    });
    const schema = { type: "object", properties: { partId: { type: "string" } } };
    assert.deepEqual(
      claudeMcpToolForApps({ name: "cad.view", description: "View", inputSchema: schema }),
      { name: "cad.view", description: "View", inputSchema: schema },
    );
  });

  it("builds a CallToolResult from either result shape", () => {
    assert.deepEqual(claudeMcpCallToolResult({ content: "text", structuredContent: { a: 1 } }), {
      content: [{ type: "text", text: "text" }],
      structuredContent: { a: 1 },
    });
    assert.deepEqual(
      claudeMcpCallToolResult({ content: [{ type: "text", text: "x" }], isError: true, _meta: {} }),
      { content: [{ type: "text", text: "x" }], isError: true, _meta: {} },
    );
    assert.isUndefined(claudeMcpCallToolResult({ structuredContent: {} }));
    assert.isUndefined(claudeMcpCallToolResult("nope"));
  });
});
