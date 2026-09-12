#!/usr/bin/env bash
set -euo pipefail

WORK="/home/runner/work/zen-panel/zen-panel/fork"
cd "$WORK"

echo "=== Восстановление сессии из архивных репо ==="

# ---------- 1. Функция: получить дату последнего снапшота ----------
get_latest() {
    local repo="$1"
    gh api "repos/sj0404-collab/$repo/contents/updates" \
        --jq 'sort_by(.last_modified) | last(.[]) | .name' 2>/dev/null || echo "—"
}

# ---------- 2. Собрать данные о репо ----------
REPOS=("updates-zen-agent" "updates-opencode" "updates-npm-hub")
DATA=()

for r in "${REPOS[@]}"; do
    d=$(get_latest "$r")
    DATA+=("$r|$d")
done

# ---------- 2. Вывести меню и попросить выбрать ----------
echo "Выберите repo для восстановления (введите номер 1-3):"
select repo_choice in "${REPOS[@]}"; do
    chosen=""
    for entry in "${DATA[@]}"; do
        repo_name="${entry%|*}"
        date="${entry#*|}"
        if [ "$repo_name" = "$repo_choice" ]; then
            chosen="$date"
            break
        fi
    done

    if [ -z "$chosen" ]; then
        echo "Неверный выбор. Попробуйте еще раз."
        continue
    fi

    echo "Вы выбрали reпо: $repo_choice (самый новый снапшот: $chosen)"
    break
done

# ---------- 3. Восстанавливаем из выбранного reпо ----------
repo="$repo_choice"
newest="$chosen"
echo "Извлекаем снапшот $newest из repo $repo..."

TMPDIR=$(mktemp -d)
gh api "repos/sj0404-collab/$repo/contents/updates/$newest" \
    --jq '.[].download_url' - | wget -qi - -P "$TMPDIR" 2>/dev/null || {
    echo "⚠ Не удалось скачать снапшот. Выход."
    exit 1
}

RESTORE_DIR="$WORK/restored-from-$repo"
mkdir -p "$RESTORE_DIR"

find "$TMPDIR" -type f -not -name '*.apk' | while read -r f; do
    relpath="${f#$TMPDIR/}"
    case "$relpath" in
        *gradle*|*/gradle/*|*/gradle*) continue ;;
    esac
    mkdir -p "$RESTORE_DIR/$(dirname "$relpath")"
    cp -r "$f" "$RESTORE_DIR/$relpath"
done

if [ -f "$TMPDIR/manifest.json" ]; then
    cp "$TMPDIR/manifest.json" "$RESTORE_DIR/"
fi

# ---------- 4. Сохраняем незапущенные изменения (git stash) ----------
cd "$WORK"
git stash push -- . ':!*.apk' ':!gradle*' 2>/dev/null || echo "ℹ Не было локальных изменений."

# ---------- 5. Копируем восстановленные файлы в рабочую папку ----------
rm -rf "$RESTORE_DIR"
cp -r "$WORK/restored-from-$repo"/* "$WORK/" 2>/dev/null || true

# ---------- 6. Финальное сообщение ----------
echo ""
echo "========================================="
echo "Восстановление из repo $repo завершено."
echo "Снапшот: $newest"
echo "Копировано файлов: $((count+1)) (без *.apk и gradle)."
echo "Незапущенные изменения сохранены в git‑стэше."
echo "Чтобы верните выполните: git stash pop"
echo "========================================="
