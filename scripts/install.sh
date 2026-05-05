#!/bin/bash
# scripts/install.sh — 互換ラッパー（旧 URL 維持用）
#
# Agent-Aiko Phase 0 のリポ構造リネームに伴い、Claude Code 版 installer の
# 実体は claude-code/scripts/install.sh に移動した。
#
# 旧 URL（https://raw.githubusercontent.com/masa-san-jp/Agent-Aiko/main/scripts/install.sh）
# を README やブログ等で参照しているユーザーのために、本ラッパーを残し、
# (a) ローカル実行 (b) curl | bash のいずれの経路でも実体に dispatch する。
#
# 動作モード判定：
#   $0 が実ファイル（-f テストが真）→ ローカル実行。同階層から相対パスで dispatch
#   それ以外（stdin / プロセス置換）→ curl | bash 実行。raw URL を fetch して dispatch
#
# 詳細は dev-docs/2026-05-05-Agent-Aiko-Codex-design.md §3.3 を参照。

set -euo pipefail

REF="${AGENT_AIKO_REF:-main}"   # ブランチ／タグを上書き可能（CI・dev 用）
RAW_BASE="https://raw.githubusercontent.com/masa-san-jp/Agent-Aiko/${REF}"

if [ -f "$0" ]; then
  # ローカル実行：同リポの claude-code/scripts/install.sh を呼ぶ
  exec "$(dirname "$0")/../claude-code/scripts/install.sh" "$@"
else
  # curl | bash 実行：raw URL から実体を fetch して bash プロセス置換で実行
  exec bash <(curl -fsSL "${RAW_BASE}/claude-code/scripts/install.sh") "$@"
fi
