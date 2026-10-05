# AGENTS.md

## Workflow (user requirement — always follow)
- After completing any code change, **always**: commit, push to a new branch, create a PR into `main`, and merge it.
- Do this every time, without being asked again ("да постоянно").
- Git identity for this repo: `NPM Hub <hub@local>`.

## Автономность (user requirement — never ask, never stop)
The user is often asleep, away, or fully offline. Work must never block on them.

- **NEVER use the `question` tool.** Do not ask for confirmation, clarification,
  or approval. Pick the most sensible option yourself, state the assumption in
  one line, and continue.
- **NEVER stop to report status and wait.** A report is not a stopping point —
  finish the whole task (edit → test → commit → push → PR → merge) first.
- Retry transient failures on your own: network timeouts, `git push` races,
  flaky tests. Retry 3× with backoff, then find a workaround. Never exit because
  of a transient error.
- If you lose the network mid-task: retry until it recovers, keep work in a
  local branch, and push when the connection returns.
- Full access is granted: bash, edit, `/tmp`, installing and downloading
  packages, `sudo`-less system changes. Do not hedge on whether you are allowed.
- Record what you did and what you assumed in the commit body, not in a prompt.

## Два пилота (user requirement)
- Агенты-пилоты: `pilot` (реализация: код, тесты, commit/push/PR) и
  `pilot-two` (решение: проектирование, ревью, разбор причины, риски).
- **Не делай работу одного пилота сам, если она явно его.** Правки и тесты —
  `pilot`, разбор и ревью — `pilot-two`.
- **Спорное место → делегируй ДО правки, а не после.** Найти причину,
  выбрать из двух вариантов, оценить последствия — работа для `pilot-two`.
- Оба работают параллельно, если разошлись по разным файлам. Один и тот же
  файл одновременно не трогать.
- Рутина («поправь опечатку», «добавь поле в JSON») — без делегирования.

## Виджон: сначала проверь себя (user requirement)
- **Прежде чем звать внешний движок — проверь, не видишь ли ты сам.**
  ```bash
  bash .opencode/skills/free-vision/can-see.sh "<твоя-модель-id>"
  ```
- exit 0 → ты работаешь на модели с вижном. **Читай картинку инструментом
  `read` и отвечай сам.** Ни base64, ни curl к Kilo/OVH, ни делегирования.
- exit 1 → модель текстовая, тогда делегируй субагенту `vision` или используй
  эндпоинты из скилла `free-vision`.
- Одно изображение — один вызов. Не гоняй внешние движки, если картинка уже
  перед глазами.