#!/bin/bash
# Aiko PostToolUse hook
# Edit / Write / MultiEdit / NotebookEdit / Bash の使用を session-state/auto.jsonl に1行追記する。
# 自動層（取りこぼし防止）の生ログ。

set -e

INPUT=$(cat)

TOOL=$(printf '%s' "$INPUT" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

case "$TOOL" in
  Edit|Write|MultiEdit|NotebookEdit|Bash) ;;
  *) exit 0 ;;
esac

PATH_VAL=$(printf '%s' "$INPUT" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
NOTEBOOK_PATH=$(printf '%s' "$INPUT" | sed -n 's/.*"notebook_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -z "$PATH_VAL" ] && PATH_VAL="$NOTEBOOK_PATH"

# Bash の場合は description を file 代わりに使う
DESC=$(printf '%s' "$INPUT" | sed -n 's/.*"description"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

LOG_DIR=".claude/aiko/session-state"
LOG_FILE="$LOG_DIR/auto.jsonl"
mkdir -p "$LOG_DIR"

TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# JSON エスケープ（最低限：" と \ のみ）
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

if [ "$TOOL" = "Bash" ]; then
  printf '{"ts":"%s","tool":"%s","desc":"%s"}\n' "$TS" "$TOOL" "$(esc "$DESC")" >> "$LOG_FILE"
else
  printf '{"ts":"%s","tool":"%s","file":"%s"}\n' "$TS" "$TOOL" "$(esc "$PATH_VAL")" >> "$LOG_FILE"
fi

# auto.jsonl が肥大化しすぎないよう、500行超えたら古いのを切り詰める
if [ -f "$LOG_FILE" ]; then
  LINES=$(wc -l < "$LOG_FILE" | tr -d ' ')
  if [ "$LINES" -gt 500 ]; then
    tail -n 500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
fi

exit 0
