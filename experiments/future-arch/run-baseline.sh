#!/bin/bash
# Local baseline: two processes, ONE machine, a plain local temp dir.
# This measures the INSTRUMENT FLOOR (poll + fs + rename), NOT a real cloud sync.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$(mktemp -d)/baseline"
mkdir -p "$DIR"
echo "shared dir: $DIR"
node "$HERE/propagation.cjs" pong --dir "$DIR" --poll 25 >/tmp/shoresh-pong.out 2>&1 &
PONG=$!
sleep 0.4
node "$HERE/propagation.cjs" ping --dir "$DIR" --n 20 --interval 150 --poll 25
kill "$PONG" 2>/dev/null || true
echo "--- responder final line ---"
tail -1 /tmp/shoresh-pong.out
