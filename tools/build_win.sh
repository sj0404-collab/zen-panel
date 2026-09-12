#!/usr/bin/env bash
# tools/build_win.sh — запуск сборки APK + тестов на Windows-раннере.
#
# Использование:
#   bash tools/build_win.sh                    # all (apk+tests)
#   bash tools/build_win.sh apk               # только APK
#   bash tools/build_win.sh tests             # только тесты
#   bash tools/build_win.sh all win-runner    # метка раннера
#
# Требует: gh (GitHub CLI), авторизация (gh auth login).

set -uo pipefail

JOB="${1:-all}"
RUNNER="${2:-windows-latest}"
REPO="${GITHUB_REPOSITORY:-sj0404-collab/zen-panel}"

echo "🚀 Диспатч build-win.yml  job=$JOB  runner=$RUNNER"
RUN_URL=$(gh workflow run build-win.yml \
  --repo "$REPO" \
  --ref main \
  --field job="$JOB" \
  --field runner_windows="$RUNNER" \
  --field label="$(date -u '+%Y-%m-%d %H:%M') build" \
  2>&1)

# Ждём завершения (макс 300 минут)
echo "⏳ Ожидание завершения (макс 5 часов)…"
gh run watch --repo "$REPO" --exit-status 2>/dev/null &
WATCH_PID=$!

# Результат: определяем последний запуск
sleep 5
LAST_ID=$(gh run list --repo "$REPO" --workflow build-win.yml --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null)
if [ -n "$LAST_ID" ]; then
  echo ""
  echo "📊 Результаты: https://github.com/$REPO/actions/runs/$LAST_ID"
  echo ""
  # Скачиваем артефакты если есть
  gh run download "$LAST_ID" --repo "$REPO" -D /tmp/build-win-artifacts 2>/dev/null && {
    echo "📦 Артефакты:"
    ls -lh /tmp/build-win-artifacts/ 2>/dev/null
    echo ""
    echo "Копирую APK в ~/hub-work …"
    cp /tmp/build-win-artifacts/*.apk ~/hub-work/ 2>/dev/null
  } || echo "(артефакты ещё не готовы — проверьте позже)"
fi

wait "$WATCH_PID" 2>/dev/null
echo "✅ Готово."
