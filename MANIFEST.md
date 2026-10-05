# Репозиторий: sj0404-collab/zen-panel

Рабочая папка этого репозитория на раннере. Всё лежит на виду —
никакие файлы не прячутся в системном /tmp.

- **Клон (работай здесь):** /home/runner/hub-work/zen-panel/code
- **Ветка:** main
- **Только твои временные файлы (сборки, кеши, артефакты):** /home/runner/hub-work/zen-panel/tmp
- **Манифест:** /home/runner/hub-work/zen-panel/code/MANIFEST.md

## Правила для CLI-агентов
1. НИКОГДА не создавай файлы в /tmp или os.tmpdir() — это не твоя папка.
2. Временные файлы создавай ТОЛЬКО в /home/runner/hub-work/zen-panel/tmp.
3. Исходники и изменения делай в /home/runner/hub-work/zen-panel/code; пуши в git оттуда.
4. GitHub-токен доступен в переменной окружения $GH_TOKEN — никогда не выводи
   и не логируй его значение.
5. Готовые сборки/артефакты клади в /home/runner/hub-work/zen-panel/tmp — их видно вкладкой «Файлы».
