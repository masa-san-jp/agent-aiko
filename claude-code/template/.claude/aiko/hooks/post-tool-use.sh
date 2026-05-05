#!/bin/bash
# Aiko PostToolUse hook
# Edit / Write / MultiEdit / NotebookEdit / Bash の使用を session-state/auto.jsonl に1行追記する。
# 自動層（取りこぼし防止）の生ログ。
#
# このフックは「後処理ログ」の位置づけで、失敗してもユーザー操作を止めない。
# したがって set -e は使わず、最後は必ず exit 0 する。

INPUT=$(cat)

TOOL=$(printf '%s' "$INPUT" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

case "$TOOL" in
  Edit|Write|MultiEdit|NotebookEdit|Bash) ;;
  *) exit 0 ;;
esac

PATH_VAL=$(printf '%s' "$INPUT" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
NOTEBOOK_PATH=$(printf '%s' "$INPUT" | sed -n 's/.*"notebook_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -z "$PATH_VAL" ] && PATH_VAL="$NOTEBOOK_PATH"

DESC=$(printf '%s' "$INPUT" | sed -n 's/.*"description"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

LOG_DIR=".claude/aiko/session-state"
LOG_FILE="$LOG_DIR/auto.jsonl"

mkdir -p "$LOG_DIR" 2>/dev/null || exit 0

TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Python の json.dumps で 1 行 JSON を確実に生成（改行・タブ・制御文字も適切にエスケープされる）
LINE=$(TS="$TS" TOOL="$TOOL" PATH_VAL="$PATH_VAL" DESC="$DESC" python3 -c '
import json, os
tool = os.environ.get("TOOL", "")
ts = os.environ.get("TS", "")
if tool == "Bash":
    obj = {"ts": ts, "tool": tool, "desc": os.environ.get("DESC", "")}
else:
    obj = {"ts": ts, "tool": tool, "file": os.environ.get("PATH_VAL", "")}
print(json.dumps(obj, ensure_ascii=False))
' 2>/dev/null)

if [ -n "$LINE" ]; then
  printf '%s\n' "$LINE" >> "$LOG_FILE" 2>/dev/null || true
fi

# 500 行超えたら古い分を切り詰める（失敗しても無視）
if [ -f "$LOG_FILE" ]; then
  LINES=$(wc -l < "$LOG_FILE" 2>/dev/null | tr -d ' ')
  if [ -n "$LINES" ] && [ "$LINES" -gt 500 ] 2>/dev/null; then
    tail -n 500 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE" 2>/dev/null || true
  fi
fi

exit 0
