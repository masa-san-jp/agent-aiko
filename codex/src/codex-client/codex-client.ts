// CodexClient — high-level client for codex app-server.
//
// 設計の正本: dev-docs/2026-05-05-Agent-Aiko-Codex-design.md v0.3.1 §6.1

import {
  type IncomingMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonValue,
  LineBuffer,
  encode,
  parseIncoming,
} from "./jsonrpc.js";
import { ProcessManager } from "./process-manager.js";
import type {
  AccountInfo,
  AskOptions,
  AskResult,
  CodexClientOptions,
  StartThreadOptions,
} from "./types.js";

interface PendingRequest {
  resolve: (value: JsonValue) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface ActiveTurn {
  threadId: string;
  turnId: string;
  resolveAsk: (result: AskResult) => void;
  rejectAsk: (reason: Error) => void;
  buffer: string[];
  abortListener: (() => void) | null;
  abortSignal: AbortSignal | undefined;
  onStarted: ((turnId: string) => void) | undefined;
  onDelta: ((chunk: string) => void) | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = "2024-11-05";

/**
 * codex app-server との JSON-RPC 通信を抽象化する高レベルクライアント。
 *
 * 使い方：
 * ```ts
 * const client = new CodexClient();
 * await client.start();
 * const { threadId } = await client.startThread({ baseInstructions: "..." });
 * const { text } = await client.ask({ threadId, text: "hello", onDelta });
 * await client.stop();
 * ```
 */
export class CodexClient {
  readonly #options: CodexClientOptions;
  readonly #process: ProcessManager;
  readonly #buffer = new LineBuffer();
  readonly #pending = new Map<number, PendingRequest>();
  /** 進行中ターン（threadId をキーに 1 件のみ管理）。 */
  readonly #activeTurns = new Map<string, ActiveTurn>();
  #nextId = 1;
  #ready = false;

  constructor(options: CodexClientOptions = {}) {
    this.#options = options;
    this.#process = new ProcessManager({
      ...(options.serverPath !== undefined ? { serverPath: options.serverPath } : {}),
      ...(options.codexHome !== undefined ? { codexHome: options.codexHome } : {}),
      ...(options.onLog !== undefined ? { onLog: options.onLog } : {}),
      onExit: (code, signal) => this.#handleExit(code, signal),
    });
  }

  /** App Server を起動し initialize → initialized ハンドシェイクを完了させる。 */
  async start(): Promise<this> {
    if (this.#ready) {
      return this;
    }
    this.#process.start();
    this.#process.onStdout((chunk) => this.#handleChunk(chunk));

    await this.#request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "@agent-aiko/codex", version: "0.1.0" },
    });
    this.#notify("initialized", {});
    this.#ready = true;
    return this;
  }

  /** App Server を停止する。 */
  async stop(): Promise<void> {
    this.#ready = false;
    // 進行中の pending と turn をすべて reject する
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error("CodexClient stopped"));
    }
    this.#pending.clear();
    for (const [, t] of this.#activeTurns) {
      t.rejectAsk(new Error("CodexClient stopped"));
      if (t.abortListener && t.abortSignal) {
        t.abortSignal.removeEventListener("abort", t.abortListener);
      }
    }
    this.#activeTurns.clear();
    await this.#process.stop();
    this.#buffer.reset();
  }

  /** account/read で認証状態を取得する。 */
  async getAccount(): Promise<AccountInfo> {
    const result = (await this.#request("account/read", {})) as Record<string, JsonValue>;
    const authMode = (result["authMode"] ?? null) as string | null;
    const planType = result["planType"] as string | null | undefined;
    const info: AccountInfo = { authMode };
    if (planType !== undefined) {
      info.planType = planType;
    }
    return info;
  }

  /** thread/start で新規スレッドを作成し、threadId を返す。 */
  async startThread(opts: StartThreadOptions): Promise<{ threadId: string }> {
    const params: Record<string, JsonValue> = {
      baseInstructions: opts.baseInstructions,
    };
    if (opts.developerInstructions !== undefined) {
      params["developerInstructions"] = opts.developerInstructions;
    }
    if (opts.model !== undefined) {
      params["model"] = opts.model;
    }
    if (opts.serviceTier !== undefined) {
      params["serviceTier"] = opts.serviceTier;
    }
    if (opts.ephemeral !== undefined) {
      params["ephemeral"] = opts.ephemeral;
    }
    const result = (await this.#request("thread/start", params)) as Record<string, JsonValue>;
    const threadId = result["threadId"];
    if (typeof threadId !== "string") {
      throw new Error(`thread/start returned no threadId: ${JSON.stringify(result)}`);
    }
    return { threadId };
  }

  /**
   * 1 ターン実行する。
   *
   * フロー：
   *   1. turn/start リクエストを送信し、応答（TurnStartResponse: {turn: {id, ...}}）から turnId を取得
   *   2. activeTurns に turnId を記録、onStarted を呼び出す
   *   3. item/agentMessage/delta 通知を集約しつつ onDelta を呼び出す
   *   4. turn/completed 通知で resolve、turn/error で reject
   *   5. AbortSignal が abort されたら turn/interrupt を発行
   *
   * 設計の正本: dev-docs/2026-05-05-Agent-Aiko-Codex-design.md v0.3.1 §6.1 / §6.7
   */
  async ask(opts: AskOptions): Promise<AskResult> {
    if (opts.abortSignal?.aborted === true) {
      throw new Error("aborted before turn started");
    }

    const params: Record<string, JsonValue> = {
      threadId: opts.threadId,
      input: [{ type: "text", text: opts.text, text_elements: [] }],
    };

    // turn/start リクエスト送信前に activeTurns プレースホルダを置く。
    // notification が response より前に届くケース（実装上ありえない想定だが）の保険。
    const placeholderId = `__pending__${this.#nextId}`;
    const askPromise = new Promise<AskResult>((resolve, reject) => {
      const turn: ActiveTurn = {
        threadId: opts.threadId,
        turnId: placeholderId,
        resolveAsk: resolve,
        rejectAsk: reject,
        buffer: [],
        abortListener: null,
        abortSignal: opts.abortSignal,
        onStarted: opts.onStarted,
        onDelta: opts.onDelta,
      };
      this.#activeTurns.set(opts.threadId, turn);

      if (opts.abortSignal) {
        const listener = (): void => {
          if (!turn.turnId.startsWith("__pending__")) {
            this.interrupt(turn.threadId, turn.turnId).catch(() => {
              // interrupt 失敗は無視（後続の turn/completed でハンドリング）
            });
          }
        };
        turn.abortListener = listener;
        opts.abortSignal.addEventListener("abort", listener);
      }
    });

    // turn/start request → response.turn.id で turnId を確定
    let turnId: string;
    try {
      const response = (await this.#request("turn/start", params)) as {
        turn: { id: string };
      };
      turnId = response.turn.id;
    } catch (err) {
      const turn = this.#activeTurns.get(opts.threadId);
      if (turn !== undefined) {
        this.#activeTurns.delete(opts.threadId);
        if (turn.abortListener && turn.abortSignal) {
          turn.abortSignal.removeEventListener("abort", turn.abortListener);
        }
      }
      throw err;
    }

    const turn = this.#activeTurns.get(opts.threadId);
    if (turn !== undefined && turn.turnId === placeholderId) {
      turn.turnId = turnId;
      turn.onStarted?.(turnId);
      // turn/start レスポンス受信前に abort されていた場合のキャッチアップ
      if (turn.abortSignal?.aborted === true) {
        this.interrupt(opts.threadId, turnId).catch(() => {
          // 失敗は turn/completed の流れで救う
        });
      }
    }

    return askPromise;
  }

  /** 進行中ターンを turn/interrupt で打ち切る。 */
  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.#request("turn/interrupt", { threadId, turnId });
  }

  /** 内部：JSON-RPC リクエストを送信し、応答を待つ。 */
  async #request(method: string, params: JsonValue): Promise<JsonValue> {
    const id = this.#nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`JSON-RPC request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#process.write(encode(req));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** 内部：JSON-RPC 通知を送信する（応答を待たない）。 */
  #notify(method: string, params: JsonValue): void {
    const note: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.#process.write(encode(note));
  }

  /** stdout の chunk を行単位に切り、各行を JSON-RPC メッセージとして処理する。 */
  #handleChunk(chunk: Buffer): void {
    for (const line of this.#buffer.push(chunk)) {
      let msg: IncomingMessage;
      try {
        msg = parseIncoming(line);
      } catch (err) {
        this.#options.onLog?.(`[parse error] ${(err as Error).message}: ${line}`);
        continue;
      }
      if ("id" in msg) {
        this.#handleResponse(msg);
      } else {
        this.#handleNotification(msg);
      }
    }
  }

  #handleResponse(msg: JsonRpcResponse): void {
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      this.#options.onLog?.(`[unexpected response] id=${msg.id}`);
      return;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if ("error" in msg) {
      pending.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  #handleNotification(msg: JsonRpcNotification): void {
    const params = (msg.params ?? {}) as Record<string, JsonValue>;
    switch (msg.method) {
      case "turn/started": {
        // 通常は turn/start レスポンスで既に turnId 確定済みなので、ここでは検証のみ。
        // ただし notification が response より先に届くケースに備えて、まだプレースホルダなら埋める。
        const threadId = params["threadId"] as string;
        const turnObj = params["turn"] as { id?: string } | undefined;
        const turnId = turnObj?.id;
        if (typeof turnId === "string") {
          const turn = this.#activeTurns.get(threadId);
          if (turn !== undefined && turn.turnId.startsWith("__pending__")) {
            turn.turnId = turnId;
            turn.onStarted?.(turnId);
          }
        }
        break;
      }
      case "item/agentMessage/delta": {
        const threadId = params["threadId"] as string;
        const delta = (params["delta"] ?? "") as string;
        const turn = this.#activeTurns.get(threadId);
        if (turn !== undefined) {
          turn.buffer.push(delta);
          turn.onDelta?.(delta);
        }
        break;
      }
      case "turn/completed": {
        const threadId = params["threadId"] as string;
        const turnObj = params["turn"] as
          | { id?: string; status?: string; error?: { message?: string } | null }
          | undefined;
        const turn = this.#activeTurns.get(threadId);
        if (turn === undefined) {
          break;
        }
        this.#activeTurns.delete(threadId);
        if (turn.abortListener && turn.abortSignal) {
          turn.abortSignal.removeEventListener("abort", turn.abortListener);
        }
        const status = turnObj?.status;
        if (status === "failed") {
          const message = turnObj?.error?.message ?? "turn failed";
          turn.rejectAsk(new Error(`turn failed: ${message}`));
          break;
        }
        const text = turn.buffer.join("");
        const result: AskResult = { text, turnId: turn.turnId };
        if (status === "interrupted" || turn.abortSignal?.aborted === true) {
          result.aborted = true;
        }
        turn.resolveAsk(result);
        break;
      }
      default:
        // 未ハンドリングの notification は黙って無視（onLog 経由で観察可）
        break;
    }
  }

  #handleExit(code: number | null, _signal: NodeJS.Signals | null): void {
    this.#ready = false;
    const err = new Error(`codex app-server exited unexpectedly (code=${code ?? "null"})`);
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
    for (const [, t] of this.#activeTurns) {
      t.rejectAsk(err);
      if (t.abortListener && t.abortSignal) {
        t.abortSignal.removeEventListener("abort", t.abortListener);
      }
    }
    this.#activeTurns.clear();
  }
}
