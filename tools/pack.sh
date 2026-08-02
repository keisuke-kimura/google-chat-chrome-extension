#!/usr/bin/env bash
#
# 配布用のパッケージを作る。
#
#   bash tools/pack.sh        → dist/chat-booster-<version>.zip
#   bash tools/pack.sh --crx  → 上記に加えて dist/chat-booster-<version>.crx（key.pem が必要）
#
# zip はそのまま Chrome ウェブストアにアップロードできる。
# 社内に直接配る場合は、受け取った人が展開して
# 「パッケージ化されていない拡張機能を読み込む」で読み込む。

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./manifest.json').version" 2>/dev/null || echo "0.0.0")
OUT_DIR="dist"
BASENAME="chat-booster-${VERSION}"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$BASENAME.zip"

# 拡張の実体だけを詰める（tools / dist / git / 鍵 は含めない）
zip -r -q "$OUT_DIR/$BASENAME.zip" \
  manifest.json \
  icons \
  src \
  README.md \
  -x '*.DS_Store'

echo "作成: $OUT_DIR/$BASENAME.zip"

if grep -q '"client_id": *"REPLACE_WITH_YOUR_CLIENT_ID' manifest.json; then
  echo
  echo "⚠️  manifest.json の oauth2.client_id がプレースホルダーのままです。"
  echo "    このまま配ると、受け取った人は接続できません。"
fi

if ! grep -q '"key"' manifest.json; then
  echo
  echo "ℹ️  manifest.json に \"key\" がありません。"
  echo "    zip を直接配る場合、読み込む人ごとに拡張 ID が変わり OAuth が通りません。"
  echo "    bash tools/make-key.sh を実行して \"key\" を追加してください。"
  echo "    （ウェブストアで公開する場合は \"key\" 不要です）"
fi

if [[ "${1:-}" == "--crx" ]]; then
  if [[ ! -f key.pem ]]; then
    echo "key.pem がありません。先に bash tools/make-key.sh を実行してください。" >&2
    exit 1
  fi
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [[ ! -x "$CHROME" ]]; then
    echo "Chrome が見つかりません: $CHROME" >&2
    exit 1
  fi
  STAGE=$(mktemp -d)
  unzip -q "$OUT_DIR/$BASENAME.zip" -d "$STAGE"
  "$CHROME" --pack-extension="$STAGE" --pack-extension-key=key.pem >/dev/null 2>&1 || true
  if [[ -f "$STAGE.crx" ]]; then
    mv "$STAGE.crx" "$OUT_DIR/$BASENAME.crx"
    echo "作成: $OUT_DIR/$BASENAME.crx"
    echo
    echo "⚠️  .crx をファイルとして配っても、Chrome は既定でインストールを拒否します"
    echo "    （ウェブストア以外からの .crx はブロックされる）。"
    echo "    管理コンソールのポリシー配布か、ウェブストア公開を使ってください。"
  fi
  rm -rf "$STAGE"
fi
