#!/usr/bin/env bash
#
# 配布用の署名鍵を作り、manifest.json に入れる "key" と、その鍵から決まる
# 拡張機能 ID を表示する。
#
# なぜ必要か:
#   「パッケージ化されていない拡張機能を読み込む」で入れた拡張の ID は、
#   既定では *フォルダの絶対パス* から決まる。つまり配った相手ごとに ID が変わり、
#   OAuth クライアント（拡張 ID に紐づく）が一致せず接続できない。
#   manifest.json に公開鍵を "key" として書いておくと ID が固定され、
#   全員が同じ 1 つの OAuth クライアントを使えるようになる。
#
# 使い方:
#   bash tools/make-key.sh
#
# 出力される key.pem は「秘密鍵」。git には入らない（.gitignore 済み）。
# .crx を作り直すときに要るので、パスワードマネージャ等に保管すること。

set -euo pipefail

cd "$(dirname "$0")/.."

KEY_FILE="key.pem"

if [[ -f "$KEY_FILE" ]]; then
  echo "既に $KEY_FILE があります。既存の鍵から ID を再計算します。"
  echo "（作り直すと拡張 ID が変わり、OAuth クライアントの登録もやり直しになります）"
  echo
else
  openssl genrsa 2048 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -out "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  echo "秘密鍵を生成しました: $KEY_FILE （git 管理外・厳重に保管）"
  echo
fi

PUBKEY_B64=$(openssl rsa -in "$KEY_FILE" -pubout -outform DER 2>/dev/null | openssl base64 -A)
EXT_ID=$(openssl rsa -in "$KEY_FILE" -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | xxd -p -c 32 \
  | head -c 32 \
  | tr '0-9a-f' 'a-p')

cat <<EOF
────────────────────────────────────────────────────────
拡張機能 ID（固定）:

  $EXT_ID

この ID を Google Cloud Console の OAuth クライアント
（種類: Chrome 拡張機能）の「アイテム ID」に登録してください。
────────────────────────────────────────────────────────

manifest.json の先頭付近に、次の1行を追加してください:

  "key": "$PUBKEY_B64",

────────────────────────────────────────────────────────
注意: Chrome ウェブストアで公開する場合は、この "key" 行を
      削除してからアップロードしてください。ストアが独自に
      ID を発行するため、競合します。
EOF
