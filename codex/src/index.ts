// Agent-Aiko for Codex — public package entry.
//
// 設計の正本: dev-docs/2026-05-05-Agent-Aiko-Codex-design.md v0.3.1

export const PACKAGE = "@agent-aiko/codex" as const;
export const VERSION = "0.2.0" as const;
export const PHASE = "phase-2-codex-client" as const;

export { CodexClient } from "./codex-client/index.js";
export type {
  AccountInfo,
  AskOptions,
  AskResult,
  CodexClientOptions,
  StartThreadOptions,
} from "./codex-client/index.js";
