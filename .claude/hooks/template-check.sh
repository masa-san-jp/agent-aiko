#!/bin/bash
# claude-code/template/ に開発者専用リポ（dev-docs / Agent-Aiko-dev）への参照が
# 混入していないかチェックする。
# Phase 0 のリポ構造リネームで template/ → claude-code/template/ に移動。
# その後 dev-docs/ は ../Agent-Aiko-dev/ へ兄弟分離（旧名も後方互換で検出）。

TEMPLATE_DIR="claude-code/template"

[ -d "$TEMPLATE_DIR" ] || exit 0

# URL 内の Agent-Aiko-dev（公開アセット参照）は許容するため、`://` を含む行は除外する
VIOLATIONS=$(grep -rnE "dev-docs|Agent-Aiko-dev" "$TEMPLATE_DIR/" \
  --include="*.md" --include="*.sh" --include="*.json" 2>/dev/null \
  | grep -v "://" \
  | cut -d: -f1 | sort -u)

[ -n "$VIOLATIONS" ] || exit 0

echo "⛔ [template-check] 配布用 $TEMPLATE_DIR/ に開発者専用リポ参照が含まれています：" >&2
echo "$VIOLATIONS" >&2
echo "" >&2
echo "配布用ファイルから開発者固有のパス（dev-docs / Agent-Aiko-dev）を削除してから push してください。" >&2
echo "詳細は /dev-check スキルで確認できます。" >&2
exit 2
