# Cloud Phone — доработки и план

## Текущее состояние (коммиты)
- **npm-hub** (репозиторий `zen-panel`):
  - вкладка **Телефон**: кнопки Старт/Стоп/Подключить/⛶, статус, iframe noVNC через `/phone/vnc.html?autoconnect=1&path=ws/vnc`
  - сервер: `/api/phone/status|start|stop`, WS-прокси `/ws/vnc → tcp://127.0.0.1:5900`
  - пульс: sinks `cloud_phone`, `browser_youtube`, loopback'и
  - вкладка **Экран (Linux Desktop)**: параллельный раннер `vnc` в `hub.yml`, который с первой секунды поднимает headless-рабочий стол (openbox + xterm + tint2, Mesa/llvmpipe) на Xvfb :99 и отдаёт его через x11vnc + noVNC + cloudflared-туннель
  - сервер: `/api/vnc/status` читает `session-vnc.json` со ветки `session-state`, `/desktop-vnc` — редирект на живой адрес
- **android-cloud-phone** (origin/main = `5c3c417`):
  - `launch.sh`: Xvfb :99 1080×2400, AVD `phone` (Pixel 7, Android 14, x86_64), KVM, `-no-audio` убран, `QEMU_AUDIO_DRV=alsa`
  - `scripts/control.sh start|stop|status` — управляет стеком (эмулятор, x11vnc, websockify)
  - noVNC встроен в hub (`public/novnc/`)

## Что нужно доделать

### 1. Вкладка «Браузер» — Chrome/Kiwi внутри телефона
- Добавить API `/api/phone/browser` → `adb shell am start -n com.kiwibrowser.browser/com.google.android.apps.chrome.Main -a android.intent.action.VIEW -d <URL>`
- UI: поле ввода URL + кнопка «Открыть», кнопка «▶ YouTube»
- Результат открывается в iframe `/phone/vnc.html` (тот же VNC-стрим, только активность браузера)
- Сохранять последнюю открытую вкладку/историю в localStorage

### 2. Вкладка «Телефон» — стабильность и UX
- Авто-статус при открытии страницы (уже есть)
- Переподключение при разрыве WS (noVNC `reconnect: true`)
- Фуллскрин работает (requestFullscreen)
- Кнопка «Стоп» останавливает телефон через `control.sh stop`

### 3. Эмулятор — где взять и как настроить
**Репозиторий:** `https://github.com/sj0404-collab/android-cloud-phone`
```bash
git clone https://github.com/sj0404-collab/android-cloud-phone
cd android-cloud-phone
./install_deps.sh        # ставит qemu, x11vnc, websockify, tigerVNC, pulseaudio, ffmpeg
# SDK (нужен один раз):
/usr/local/lib/android/sdk/cmdline-tools/latest/bin/sdkmanager "emulator" "platform-tools" "system-images;android-34;default;x86_64"
/usr/local/lib/android/sdk/cmdline-tools/latest/bin/avdmanager create avd -n phone -k "system-images;android-34;default;x86_64" -d pixel_7
# Запуск:
bash scripts/control.sh start
```
**Важно:** `/dev/kvm` должен быть доступен (`sudo chmod 666 /dev/kvm` или добавить пользователя в группу `kvm`). Без KVM эмулятор не запустится.

### 4. Баг: система не откликается на касания, виснет, FPS падает

#### Диагностика (проверить по порядку)
1. **KVM и ускорение**
   - `ls -l /dev/kvm` — должен быть `crw-rw-rw-` и доступен для записи
   - В логе эмулятора (`cloud-phone.log`) искать `KVM acceleration enabled` / `accel: kvm`
   - Если «No KVM access» — эмулятор работает в TCG (медленно, FPS ~1–2)

2. **GPU-бэкенд**
   - Сейчас: `-gpu swiftshader_indirect` (CPU-рендер, низкий FPS)
   - Если на хосте есть GPU — попробовать `-gpu host` (нужен `/dev/dri/renderD128` и mesa)
   - Для headless runner без GPU — `swiftshader_indirect` единственный вариант; FPS 15–30 при 1080×2400

3. **x11vnc — производительность**
   - Флаги в `launch.sh`: `-noxdamage -noprimary -skip_duplicatekeys -shared -forever`
   - Добавить/проверить: `-noxdamage -nodri -noshm -copyrect -quality 6 -compresslevel 6`
   - Отключить композитинг: `-noxdamage` уже есть; `-noshm` иногда помогает на CPU

4. **noVNC — настройки**
   - В `public/novnc/vnc.html` (или при инициализации) можно добавить:
     ```js
     RFB.defaults = { ...RFB.defaults, scaleViewport: true, resizeSession: true };
     ```
   - WS-прокси `/ws/vnc` должен передавать бинарные кадры без перекодирования

5. **Android UI — ANR / System UI диалоги**
   - После загрузки часто появляется ANR `systemui` — диалог «Close app»
   - Авто-закрытие: `adb shell input tap 540 1273` (координаты кнопки «Close app» на 1080×2400)
   - Или `adb shell am force-stop com.android.systemui` (но может сломать лаунчер)

6. **Ресурсы эмулятора**
   - RAM: `-memory 4096` (можно поднять до 6144)
   - CPU cores: `-cores 2` (runner обычно 2–4 vCPU)
   - Отключить снимки/анимации: `-no-snapshot -no-boot-anim` (уже есть)
   - Отключить Vulkan: `-feature -Vulkan` (уже есть)

7. **Сетевой стек / adb**
   - Порт 5554 (adb) — проверка `adb devices`
   - Wi-Fi внутри эмулятора: `AndroidWifi` 10.0.2.0/24, шлюз 10.0.2.2
   - Если интернета нет — `adb shell "settings put global wifi_on 1"` / перезагрузка эмулятора

8. **Аудио (в процессе)**
   - Сейчас `QEMU_AUDIO_DRV=alsa` + `~/.asoundrc` → Pulse sink `cloud_phone`
   - Проверка: `pactl list sink-inputs` — должен появиться клиент `qemu` / `Android` при воспроизведении
   - Если нет — перейти на `-audio pulse` (если QEMU собран с поддержкой pulse) или явный `-audiodev pa`

#### План фиксов (порядок)
1. Проверить KVM (`ls -l /dev/kvm`, лог эмулятора).
2. Запустить `scripts/control.sh start` — дождаться `boot_completed=1`.
3. Запустить x11vnc с расширенными флагами; `websockify 6080 localhost:5900`.
4. Подключиться через hub `/phone/vnc.html` — проверить FPS (glances / `adb shell dumpsys gfxinfo`).
5. Если FPS < 15 — попробовать `-gpu host` (если есть GPU) или снизить разрешение до 720×1520.
6. Добавить авто--dismiss ANR (`adb shell input tap 540 1273` в `wait_for_boot`).
7. Оптимизировать x11vnc: `-noxdamage -nodri -noshm -copyrect`.
8. Аудио: убедиться, что Pulse sink `cloud_phone` получает поток; если нет — переключить на `-audio pulse` (требует QEMU с pulse).

### 5. Полный цикл рестарта (после выключения)
```bash
# 1. Остановить телефон
cd ~/android-cloud-phone && bash scripts/control.sh stop
# 2. Убить остатки
pkill -9 -f "qemu-system|x11vnc|websockify|Xvfb :99"
# 3. Очистить Pulse дубликаты (если hub перезапускался)
pactl list short modules | awk '/null-sink|loopback/ {print $1}' | xargs -r pactl unload-module
# 4. Запустить телефон
tmux new-session -d -s phone "bash launch.sh 2>&1 | tee /tmp/phone.log"
# 5. Ждать boot_completed=1 (1–2 мин)
# 6. Запустить hub (если не жив)
cd /home/runner/work/zen-panel/zen-panel/fork/npm-hub && node src/server.js
# 7. Проверить /api/phone/status → {running:true, adb:true}
# 8. Открыть hub в браузере → вкладка Телефон → «▶ Старт» → «Подключить»
```

### 6. Приоритеты
| # | Задача | Статус |
|---|--------|--------|
| 1 | KVM + GPU ускорение | ✅ KVM работает, GPU — swiftshader |
| 2 | x11vnc флаги для FPS | ✅ добавлены в `launch.sh` (android-cloud-phone) |
| 3 | ANR авто-закрытие | ✅ `dismiss_anr()` в `wait_for_boot` |
| 4 | Аудио в sink `cloud_phone` | 🔄 текущая попытка ALSA→Pulse |
| 5 | Вкладка «Браузер» API + UI | ✅ выполнено + восстановление `cp.lastUrl` |
| 6 | Вкладка «Телефон» — авто-реконнект | ✅ noVNC `reconnect=1` |
| 7 | Документация запуска для CI | ✅ `install_deps.sh`, `control.sh` |
| 8 | Linux Desktop (Экран) — паралл. раннер | ✅ `vnc` job в `hub.yml`, `start_desktop.sh`, кнопка в UI |

---

> **Примечание:** живой hub на порту 8090 (PID 29164) не трогать без нужды — правки вступают в силу после `git push` и следующего рестарта keep-alive workflow.