# Свой ПК как раннер (self-hosted)

Регистрирует эту машину self-hosted Actions-раннером репозитория. После
этого запуски из панели (агент, OpenCode, хаб, столы) можно выполнять не
в облаке GitHub, а здесь — в диалоге запуска выбирается «свой ПК».

## Установка

1. Возьмите одноразовый токен: Settings репозитория → Actions → Runners →
   **New self-hosted runner** (покажут `config.sh --token ...` — нужен сам токен).
2. Запустите:
   ```bash
   pc-local/runner/setup.sh     # Linux/macOS
   pc-local\runner\setup.bat    # Windows
   ```
   Скрипт сам определит URL репо (из git remote) и свежую версию раннера
   (через API релизов), скачает пакет в `runner/actions-runner/` и
   зарегистрирует машину. Переменные окружения вместо вопросов:
   `REPO_URL`, `REG_TOKEN`, `RUNNER_NAME`, `RUNNER_LABELS`, `RUNNER_VERSION`.
3. Запустите раннер: `runner/actions-runner/run.sh` (или `run.cmd`),
   либо как сервис: `sudo ./svc.sh install && sudo ./svc.sh start`.
4. В панели при запуске выбирайте «свой ПК» — workflow поедет на `self-hosted`.

Каталог `actions-runner/` (бинарники + credentials машины) в git не входит
(см. `pc-local/.gitignore`). Удаление регистрации: `./config.sh remove --token <новый-токен>`.

## Важно

- **Совпадение ОС.** Linux-задание упадёт на Windows-машине и наоборот —
  выбирайте ОС запуска под свой ПК. `which: both` для столов требует две
  машины (или смиритесь, что выживет одна половина).
- **Офлайн = очередь навсегда.** Если раннер не запущен, задание висит
  `queued`, пока машина не появится. Панель это покажет («в очереди»).
- **Безопасность.** Self-hosted + публичный репозиторий обычно опасны
  (чужой PR исполняется у вас). Здесь переопределение раннера есть только
  у четырёх workflow с `workflow_dispatch` (запуск требует прав записи),
  а CI на PR (`tests.yml`, `js-syntax.yml`) всегда едет в облако GitHub —
  так и оставляйте.
