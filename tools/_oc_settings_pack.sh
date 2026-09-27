#!/usr/bin/env bash
# Pack the opencode settings into a work-backup stage dir, and record where
# every file came from so restore-work.sh can put each one back byte-identical.
# Not shipped on PATH: helper for backup-work.sh only.
set -uo pipefail
stage="$1"; repos_root="${2:-$HOME/hub-work}"
out="$stage/opencode/settings"
manifest="$out/manifest.json"
first=1
listing="["
pack_one() {
  local src="$1" rel="$2" dest="$3"
  [ -f "$src" ] || return 0
  mkdir -p "$(dirname "$dest")" || return 0
  cp "$src" "$dest" || return 0
  if [ "$first" = 1 ]; then first=0; else listing="$listing,"; fi
  rel="$(printf '%s' "$rel" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  dest_rel="${dest#"$stage/"}"
  listing="$listing{"'"'"rel"'"'":$rel,"'"'"file"'"'":"'"'"$dest_rel"'"'"}"
}
pack_one "$HOME/.config/opencode/opencode.json" "$HOME/.config/opencode/opencode.json" "$out/opencode.json"
pack_one "$HOME/.opencode.json"                        "$HOME/.opencode.json"                        "$out/opencode.dot.json"
if [ -d "$repos_root" ]; then
  for f in "$repos_root"/*/opencode.json; do
    [ -f "$f" ] || continue
    base="$(basename "$(dirname "$f")" | tr -c 'A-Za-z0-9._-' '_')"
    pack_one "$f" "$repos_root/$base/opencode.json" "$out/projects/$base.opencode.json"
  done
fi
listing="$listing]"
mkdir -p "$out" || exit 0
printf '%s\n' "$listing" > "$manifest" || true
exit 0
