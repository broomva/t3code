// BRO-3226 scratch harness — NOT for commit. Connects to a running T3 server as a
// mobile client and meters received websocket bytes per RPC subscription.
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { readFileSync, writeFileSync } from "node:fs";

import { BearerConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as RpcSession from "./session.ts";

const DIR = process.env.BRO3226_DIR ?? "/tmp/bro-3226/live";
const SERVER = process.env.BRO3226_SERVER ?? "http://127.0.0.1:3773";
const ENV_FILE = process.env.BRO3226_ENV_FILE ?? `${process.env.HOME}/.t3/userdata/environment-id`;
const WARMUP_MS = Number(process.env.BRO3226_WARMUP_MS ?? 15_000);
const MEASURE_MS = Number(process.env.BRO3226_MEASURE_MS ?? 60_000);

const cookie = readFileSync(`${DIR}/cookies.txt`, "utf8")
  .split("\n")
  .map((l) => l.replace(/^#HttpOnly_/, "").split("\t"))
  .filter((f) => f.length >= 7)
  .map((f) => `${f[5]}=${f[6]}`)
  .join("; ");

interface Meter {
  measuring: boolean;
  tagById: Map<string, string>;
  bytes: Map<string, number>;
  frames: Map<string, number>;
  itemKinds: Map<string, number>;
  itemKindBytes: Map<string, number>;
}
const meter: Meter = {
  measuring: false,
  tagById: new Map(),
  bytes: new Map(),
  frames: new Map(),
  itemKinds: new Map(),
  itemKindBytes: new Map(),
};
const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);

function observe(raw: string) {
  if (!meter.measuring) return;
  let msg: { _tag?: string; requestId?: string; values?: unknown[] };
  try {
    msg = JSON.parse(raw);
  } catch {
    add(meter.bytes, "<unparsed>", raw.length);
    return;
  }
  const tag = msg.requestId ? (meter.tagById.get(String(msg.requestId)) ?? `req:${msg.requestId}`) : `<${msg._tag}>`;
  add(meter.bytes, tag, raw.length);
  add(meter.frames, tag, 1);
  for (const value of msg.values ?? []) {
    const v = value as { kind?: string; _tag?: string; type?: string };
    const kind = `${tag} :: ${v?.kind ?? v?._tag ?? v?.type ?? typeof value}`;
    add(meter.itemKinds, kind, 1);
    add(meter.itemKindBytes, kind, JSON.stringify(value).length);
  }
}

const MeteredWebSocket = (url: string, protocols?: string | string[]) => {
  const ws = new globalThis.WebSocket(url, protocols);
  const send = ws.send.bind(ws);
  ws.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
    if (typeof data === "string") {
      try {
        const m = JSON.parse(data) as { _tag?: string; id?: string; tag?: string };
        if (m._tag === "Request" && m.id && m.tag) meter.tagById.set(String(m.id), m.tag);
      } catch {}
    }
    send(data as string);
  };
  ws.addEventListener("message", (event) => {
    const d = event.data;
    observe(typeof d === "string" ? d : Buffer.from(d as ArrayBuffer).toString("utf8"));
  });
  return ws;
};

it.live(
  "meter T3 websocket streams by subscription",
  () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make(readFileSync(ENV_FILE, "utf8").trim());
      const ticket = yield* Effect.promise(async () => {
        const res = await fetch(`${SERVER}/api/auth/websocket-ticket`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json", origin: SERVER },
          body: "{}",
        });
        return ((await res.json()) as { ticket: string }).ticket;
      });
      const target = new BearerConnectionTarget({ environmentId, label: "meter", connectionId: "bearer:meter" });
      const host = SERVER.replace(/^http/, "ws");
      const prepared: PreparedConnection = {
        environmentId,
        label: "meter",
        httpBaseUrl: `${SERVER}/`,
        socketUrl: `${host}/ws?wsTicket=${encodeURIComponent(ticket)}&clientSurface=mobile&orchestrationProtocol=2`,
        httpAuthorization: null,
        target,
      };
      const factory = yield* RpcSession.make({});
      const session = yield* factory.connect(prepared);
      yield* session.ready;
      const client = session.client as unknown as Record<string, (input: unknown) => Stream.Stream<unknown, unknown>>;
      yield* client["orchestration.subscribeShell"]!({}).pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);

      yield* Effect.sleep(`${WARMUP_MS} millis`);
      meter.measuring = true;
      yield* Effect.sleep(`${MEASURE_MS} millis`);
      meter.measuring = false;

      const secs = MEASURE_MS / 1000;
      const lines: string[] = [`measured ${secs}s after ${WARMUP_MS / 1000}s warmup against ${SERVER}`];
      const total = [...meter.bytes.values()].reduce((a, b) => a + b, 0);
      lines.push(`TOTAL ${(total / secs / 1024).toFixed(1)} KB/s (${(total / 1024 / 1024).toFixed(2)} MB)`);
      for (const [k, v] of [...meter.bytes].sort((a, b) => b[1] - a[1]))
        lines.push(`  ${(v / secs / 1024).toFixed(1).padStart(7)} KB/s  ${String(meter.frames.get(k)).padStart(5)} frames  ${k}`);
      lines.push("item kinds:");
      for (const [k, v] of [...meter.itemKindBytes].sort((a, b) => b[1] - a[1]).slice(0, 20))
        lines.push(`  ${(v / secs / 1024).toFixed(1).padStart(7)} KB/s  ${String(meter.itemKinds.get(k)).padStart(5)} items  ${k}`);
      writeFileSync(`${DIR}/meter-${Date.now()}.txt`, lines.join("\n") + "\n");
      console.log(lines.join("\n"));
      expect(total).toBeGreaterThanOrEqual(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.succeed(Socket.WebSocketConstructor, MeteredWebSocket as never)),
    ),
  { timeout: 300_000 },
);
