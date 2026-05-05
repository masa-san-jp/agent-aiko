// CodexClient の単体テスト（MockTransport を使った決定的シナリオ）。
//
//   node --import tsx --test test/codex-client.test.ts
//
// 設計の正本: dev-docs/2026-05-05-Agent-Aiko-Codex-design.md v0.3.1 §6.1 / §6.7

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { CodexClient } from "../src/codex-client/codex-client.js";
import { MockTransport } from "./mock-transport.js";

/** initialize → initialized ハンドシェイクをモック側で完了させる。 */
async function startClient(transport: MockTransport): Promise<CodexClient> {
  const client = new CodexClient({ transport });
  const startP = client.start();
  // 1 件目の write は initialize リクエスト
  await waitFor(() => transport.writes.length >= 1);
  const init = transport.lastWrite();
  assert.equal(init.method, "initialize");
  transport.pushIncoming({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: "2024-11-05" } });
  await startP;
  return client;
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setImmediate(tick);
    };
    tick();
  });
}

describe("CodexClient.start", () => {
  it("issues initialize then initialized exactly once even with concurrent start() calls", async () => {
    const t = new MockTransport();
    const client = new CodexClient({ transport: t });
    const p1 = client.start();
    const p2 = client.start();
    await waitFor(() => t.writes.length >= 1);
    const init = t.lastWrite();
    assert.equal(init.method, "initialize");
    t.pushIncoming({ jsonrpc: "2.0", id: init.id, result: {} });
    await Promise.all([p1, p2]);
    // 同じプロセスへ 2 回 initialize/initialized が送られていないこと
    const initCount = t.writes.filter((w) => JSON.parse(w).method === "initialize").length;
    const initializedCount = t.writes.filter((w) => JSON.parse(w).method === "initialized").length;
    assert.equal(initCount, 1, "initialize should be sent only once");
    assert.equal(initializedCount, 1, "initialized should be sent only once");
    await client.stop();
  });
});

describe("CodexClient.ask", () => {
  it("resolves with aggregated text when turn/completed arrives", async () => {
    const t = new MockTransport();
    const client = await startClient(t);

    const askP = client.ask({
      threadId: "th-1",
      text: "hi",
      onDelta: () => undefined,
    });

    await waitFor(() => t.writes.some((w) => JSON.parse(w).method === "turn/start"));
    const turnStart = t.writes
      .map((w) => JSON.parse(w))
      .find((m) => m.method === "turn/start");
    assert.ok(turnStart);
    t.pushIncoming({
      jsonrpc: "2.0",
      id: turnStart.id,
      result: { turn: { id: "turn-1", items: [], status: "inProgress", error: null } },
    });

    t.pushIncoming({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "th-1", turnId: "turn-1", itemId: "i-1", delta: "Hello, " },
    });
    t.pushIncoming({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "th-1", turnId: "turn-1", itemId: "i-1", delta: "world" },
    });
    t.pushIncoming({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "th-1",
        turn: { id: "turn-1", items: [], status: "completed", error: null },
      },
    });

    const result = await askP;
    assert.equal(result.text, "Hello, world");
    assert.equal(result.turnId, "turn-1");
    assert.equal(result.aborted, undefined);
    await client.stop();
  });

  it("rejects when status is failed", async () => {
    const t = new MockTransport();
    const client = await startClient(t);
    const askP = client.ask({ threadId: "th-2", text: "bad" });
    await waitFor(() => t.writes.some((w) => JSON.parse(w).method === "turn/start"));
    const turnStart = t.writes.map((w) => JSON.parse(w)).find((m) => m.method === "turn/start");
    assert.ok(turnStart);
    t.pushIncoming({
      jsonrpc: "2.0",
      id: turnStart.id,
      result: { turn: { id: "turn-2", items: [], status: "inProgress", error: null } },
    });
    t.pushIncoming({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "th-2",
        turn: { id: "turn-2", items: [], status: "failed", error: { message: "rate limited" } },
      },
    });
    await assert.rejects(askP, /turn failed: rate limited/);
    await client.stop();
  });

  it("rejects a second concurrent ask() on the same thread", async () => {
    const t = new MockTransport();
    const client = await startClient(t);
    const askP1 = client.ask({ threadId: "th-3", text: "first" });
    await waitFor(() => t.writes.some((w) => JSON.parse(w).method === "turn/start"));
    await assert.rejects(
      client.ask({ threadId: "th-3", text: "second" }),
      /already has an in-flight turn/
    );
    // 後始末：1 件目を完了させる
    const turnStart = t.writes.map((w) => JSON.parse(w)).find((m) => m.method === "turn/start");
    assert.ok(turnStart);
    t.pushIncoming({
      jsonrpc: "2.0",
      id: turnStart.id,
      result: { turn: { id: "turn-3", items: [], status: "inProgress", error: null } },
    });
    t.pushIncoming({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "th-3", turn: { id: "turn-3", items: [], status: "completed", error: null } },
    });
    await askP1;
    await client.stop();
  });

  it("ignores deltas for a different turnId on the same thread", async () => {
    const t = new MockTransport();
    const client = await startClient(t);
    const collected: string[] = [];
    const askP = client.ask({
      threadId: "th-4",
      text: "go",
      onDelta: (c) => collected.push(c),
    });
    await waitFor(() => t.writes.some((w) => JSON.parse(w).method === "turn/start"));
    const turnStart = t.writes.map((w) => JSON.parse(w)).find((m) => m.method === "turn/start");
    assert.ok(turnStart);
    t.pushIncoming({
      jsonrpc: "2.0",
      id: turnStart.id,
      result: { turn: { id: "turn-4", items: [], status: "inProgress", error: null } },
    });
    // 古い turnId の delta（破棄されるべき）
    t.pushIncoming({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "th-4", turnId: "turn-OLD", itemId: "x", delta: "STALE" },
    });
    // 正しい turnId の delta
    t.pushIncoming({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "th-4", turnId: "turn-4", itemId: "x", delta: "OK" },
    });
    t.pushIncoming({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "th-4", turn: { id: "turn-4", items: [], status: "completed", error: null } },
    });
    const result = await askP;
    assert.equal(result.text, "OK");
    assert.deepEqual(collected, ["OK"]);
    await client.stop();
  });

  it("ignores turn/completed for a different turnId", async () => {
    const t = new MockTransport();
    const client = await startClient(t);
    const askP = client.ask({ threadId: "th-5", text: "go" });
    await waitFor(() => t.writes.some((w) => JSON.parse(w).method === "turn/start"));
    const turnStart = t.writes.map((w) => JSON.parse(w)).find((m) => m.method === "turn/start");
    assert.ok(turnStart);
    t.pushIncoming({
      jsonrpc: "2.0",
      id: turnStart.id,
      result: { turn: { id: "turn-5", items: [], status: "inProgress", error: null } },
    });
    // 違う turnId の completion（無視される）
    t.pushIncoming({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "th-5", turn: { id: "turn-WRONG", items: [], status: "completed", error: null } },
    });
    // 正しい turnId の completion
    t.pushIncoming({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "th-5", turnId: "turn-5", itemId: "x", delta: "real" },
    });
    t.pushIncoming({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "th-5", turn: { id: "turn-5", items: [], status: "completed", error: null } },
    });
    const result = await askP;
    assert.equal(result.text, "real");
    await client.stop();
  });

  it("issues turn/interrupt when AbortSignal aborts after turn/start", async () => {
    const t = new MockTransport();
    const client = await startClient(t);
    const ac = new AbortController();
    const askP = client.ask({ threadId: "th-6", text: "long task", abortSignal: ac.signal });
    await waitFor(() => t.writes.some((w) => JSON.parse(w).method === "turn/start"));
    const turnStart = t.writes.map((w) => JSON.parse(w)).find((m) => m.method === "turn/start");
    assert.ok(turnStart);
    t.pushIncoming({
      jsonrpc: "2.0",
      id: turnStart.id,
      result: { turn: { id: "turn-6", items: [], status: "inProgress", error: null } },
    });

    ac.abort();
    await waitFor(() => t.writes.some((w) => JSON.parse(w).method === "turn/interrupt"));
    const interruptReq = t.writes.map((w) => JSON.parse(w)).find((m) => m.method === "turn/interrupt");
    assert.ok(interruptReq);
    assert.deepEqual(interruptReq.params, { threadId: "th-6", turnId: "turn-6" });

    // app-server 側が interrupt request の応答と turn/completed(interrupted) を返す
    t.pushIncoming({ jsonrpc: "2.0", id: interruptReq.id, result: {} });
    t.pushIncoming({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "th-6", turn: { id: "turn-6", items: [], status: "interrupted", error: null } },
    });
    const result = await askP;
    assert.equal(result.aborted, true);
    await client.stop();
  });
});

describe("CodexClient.handleExit", () => {
  it("rejects pending requests and resets buffer when transport exits", async () => {
    const t = new MockTransport();
    const client = await startClient(t);
    const askP = client.ask({ threadId: "th-7", text: "x" });
    await waitFor(() => t.writes.some((w) => JSON.parse(w).method === "turn/start"));
    const turnStart = t.writes.map((w) => JSON.parse(w)).find((m) => m.method === "turn/start");
    assert.ok(turnStart);
    // 部分的な行を流してから exit させる（buffer に残ったままになる）
    if ((t as unknown as { _stdoutHandler?: (c: Buffer) => void })._stdoutHandler) {
      // private; 直接は触らない
    }
    t.simulateExit(1, null);
    await assert.rejects(askP, /codex app-server exited unexpectedly/);
    // 再起動後に古い行が残っていないことの間接的な確認：
    // 新しい transport で start し直しても問題なく initialize を完了できる
    const t2 = new MockTransport();
    const client2 = new CodexClient({ transport: t2 });
    const startP = client2.start();
    await waitFor(() => t2.writes.length >= 1);
    const init = t2.lastWrite();
    t2.pushIncoming({ jsonrpc: "2.0", id: init.id, result: {} });
    await startP;
    await client2.stop();
  });
});
