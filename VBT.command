#!/bin/zsh
# ダブルクリックで VBT アプリを起動します。終了するにはこのウインドウを閉じてください。
cd "$(dirname "$0")/vbt" || exit 1
PORT=8765
URL="http://localhost:$PORT/"

if ! lsof -i ":$PORT" >/dev/null 2>&1; then
  (sleep 1; open -a Safari "$URL") &
  echo "VBT アプリを起動しました: $URL"
  echo "終了するにはこのウインドウを閉じてください。"
  exec python3 -m http.server "$PORT" --bind 127.0.0.1
else
  echo "すでに起動しています。ブラウザを開きます。"
  open -a Safari "$URL"
fi
