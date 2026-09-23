#!/bin/bash
# Symlinks every script in scripts/ into /usr/local/bin, named after the
# file without its extension (e.g. scripts/fixup-changes.cjs -> fixup-changes).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$REPO_DIR/scripts"
BIN_DIR="/usr/local/bin"

for script in "$SCRIPTS_DIR"/*; do
  [ -f "$script" ] || continue

  name="$(basename "$script")"
  name="${name%.*}"
  target="$BIN_DIR/$name"

  chmod +x "$script"

  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "skip: $target exists and is not a symlink" >&2
    continue
  fi

  ln -sf "$script" "$target"
  echo "linked $target -> $script"
done
