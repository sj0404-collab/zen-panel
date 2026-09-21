#!/usr/bin/env bash
# Start a headless Linux desktop on Xvfb :99 (Mesa software rendering) and
# serve it over VNC + noVNC. Used by the parallel `vnc` job in hub.yml so the
# hub gets a working graphical shell from the very first second, no user
# action needed.
#
# What is served:
#   * Xvfb :99 1920x1080x24  (softpipe/llvmpipe via Mesa - no GPU needed)
#   * openbox window manager: xterm terminal, tint2 taskbar, pcmanfm on the
#     desktop (file manager), a browser and pulseaudio - everything is
#     reachable from the screen (right-click menu), no panel buttons needed
#   * x11vnc  -> 127.0.0.1:$VNC_PORT
#   * noVNC   -> 127.0.0.1:$NOVNC_PORT/vnc.html (only if package present)
#
# Env:
#   DISPLAY_NUM   (default :99)
#   RESOLUTION    (default 1920x1080)
#   VNC_PORT      (default 5901)
#   NOVNC_PORT    (default 6081)
#
# Prints "READY" on stdout when noVNC (or VNC) is answering AND x11vnc really
# listens, else exit 1 - «отвечает» без картинки нам не подходит.
set -uo pipefail

DISPLAY_NUM="${VNC_DISPLAY:-:99}"
RESOLUTION="${VNC_RESOLUTION:-1600x900}"

VNC_PORT="${VNC_PORT:-5901}"
NOVNC_PORT="${NOVNC_PORT:-6081}"

HUB_LOGS="$HOME/.npm-hub/logs"
mkdir -p "$HUB_LOGS"

log() { echo "[+] $*"; }
warn() { echo "[!] $*"; }
err() { echo "[x] $*"; exit 1; }

# Mesa software rendering - the runner rarely has a GPU, so route every GL
# request through llvmpipe instead of failing.
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export EGL_PLATFORM=x11

INSTALL_PKGS="xvfb openbox xterm tint2 x11vnc websockify novnc dbus-x11 \
  mesa-utils libgl1-mesa-dri libgl1 libegl1 libgles2 libglu1-mesa libgbm1 \
  x11-utils x11-xserver-utils pcmanfm pulseaudio pulseaudio-utils pavucontrol feh geany \
  imagemagick xdotool wmctrl xwit xterm idesk tint2 dbus-x11"
# Проверяем КАЖДЫЙ нужный бинарь: раньше условие смотрело только на Xvfb, и на
# раннере, где Xvfb есть, а x11vnc нет, установка не запускалась вовсе —
# x11vnc потом падал с «No such file or directory», а экран оставался чёрным.
MISSING_BINS=""
for _b in Xvfb openbox x11vnc xterm idesk tint2 feh convert pcmanfm xwit; do
  command -v "$_b" >/dev/null 2>&1 || MISSING_BINS="$MISSING_BINS $_b"
done
if [ -n "$MISSING_BINS" ]; then
  warn "installing desktop stack (нет:$MISSING_BINS)"
  sudo apt-get update -qq || true
  # shellcheck disable=SC2086
  sudo apt-get install -y -qq $INSTALL_PKGS || true
  MISSING_BINS=""
  for _b in Xvfb openbox x11vnc xterm idesk tint2 feh convert xwit; do
    command -v "$_b" >/dev/null 2>&1 || MISSING_BINS="$MISSING_BINS $_b"
  done
  [ -n "$MISSING_BINS" ] && warn "всё ещё нет:$MISSING_BINS (проверьте sudo/apt на раннере)"
fi

# VNC_RESTART=1 (or RESTART=1) restarts the DESKTOP PROGRAMMES without killing
# Xvfb: that is what repaints a stale/black screen for an already connected
# client (x11vnc is restarted below, noVNC reconnects and re-reads the screen).
RESTART_DESKTOP="${VNC_RESTART:-${RESTART:-0}}"
if [ "$RESTART_DESKTOP" = "1" ]; then
  log "restart: рабочие программы (Xvfb остаётся)"
  # -x = exact process name, so a user's `xterm -e opencode` spawned from the
  # panel is never taken down by a repair.
  for prog in openbox pcmanfm tint2 feh xterm; do
    pkill -x "$prog" 2>/dev/null || true
  done
  sleep 1
fi

# ВАЖНО: Xvfb здесь НЕ убиваем — иначе каждый ремонт сносил бы окна (браузер,
# сессии) и заново поднимал весь дисплей. Живой дисплей переиспользуется ниже;
# мёртвый (сокет без процесса) убирается в ветке запуска Xvfb.
pkill -f "x11vnc.*$DISPLAY_NUM" 2>/dev/null || true
pkill -f "websockify.*$NOVNC_PORT" 2>/dev/null || true
sleep 1

SCR="${RESOLUTION}x24"
X_NUM="${DISPLAY_NUM#:}"
export DISPLAY=$DISPLAY_NUM
if [ -S "/tmp/.X11-unix/X$X_NUM" ] && pgrep -f "Xvfb $DISPLAY_NUM" >/dev/null 2>&1; then
  log "Xvfb $DISPLAY_NUM уже работает — переиспользую (быстрый перезапуск)"
else
  log "Xvfb $DISPLAY_NUM ($SCR)"
  pkill -f "Xvfb $DISPLAY_NUM" 2>/dev/null || true
  sleep 1
  rm -f "/tmp/.X11-unix/X$X_NUM" "/tmp/.X$X_NUM-lock" 2>/dev/null || true
  Xvfb "$DISPLAY_NUM" -screen 0 "$SCR" -nolisten tcp >"$HUB_LOGS/xvfb.log" 2>&1 &
  XVFB_PID=$!
  sleep 2
fi

# The screen MUST NOT blank: the video plays (audio keeps running via the
# PulseAudio bridge) but the image would go dark after a minute of no mouse
# activity - exactly "звук есть, экрана нет" on the phone. Disable the X
# screen saver and DPMS so the framebuffer stays live forever.
if command -v xset >/dev/null 2>&1; then
  xset -display "$DISPLAY_NUM" s off -dpms >/dev/null 2>&1 || true
  xset -display "$DISPLAY_NUM" s noblank >/dev/null 2>&1 || true
fi

# Seed the X resource database so xterm is usable (login shell, dark bg).
if [ -x "$(command -v xrdb)" ]; then
  xrdb -merge <(printf 'xterm*faceName: monospace\nxterm*background: #101418\n') 2>/dev/null || true
fi

log "openbox + desktop programs (pcmanfm + browser + audio + terminal)"

# Pick the best browser available (GitHub runners ship Google Chrome already).
BROWSER=""
for c in google-chrome google-chrome-stable chromium chromium-browser firefox firefox-esr; do
  if command -v "$c" >/dev/null 2>&1; then BROWSER="$c"; break; fi
done
if [ -z "$BROWSER" ]; then
  warn "no browser found, trying apt firefox..."
  sudo apt-get install -y -qq firefox 2>/dev/null || true
  command -v firefox >/dev/null 2>&1 && BROWSER=firefox
fi
log "desktop browser: ${BROWSER:-none}"

# Desktop right-click menu (openbox root menu) so every installed program is
# reachable from the screen itself - no panel buttons needed.
CFG_DIR="$HOME/.config/openbox"
mkdir -p "$CFG_DIR"
MENU_XML="$CFG_DIR/menu.xml"
{
  echo '<openbox_menu xmlns="http://openbox.org/3.1/menu">'
  echo '  <menu id="root-menu" label="Меню">'
  echo '    <item label="Терминал">'
  echo '      <action name="Execute"><command>xterm</command></action>'
  echo '    </item>'
  echo '    <item label="Файловый менеджер">'
  echo '      <action name="Execute"><command>pcmanfm</command></action>'
  echo '    </item>'
  if [ -n "$BROWSER" ]; then
    echo '    <item label="Браузер">'
    echo "      <action name=\"Execute\"><command>$BROWSER</command></action>"
    echo '    </item>'
  fi
  echo '    <item label="Звук (микшер)">'
  echo '      <action name="Execute"><command>pavucontrol</command></action>'
  echo '    </item>'
  echo '    <separator/>'
  echo '    <item label="Перезапустить рабочий стол">'
  echo '      <action name="Reconfigure"/>'
  echo '    </item>'
  echo '  </menu>'
  echo '</openbox_menu>'
} > "$MENU_XML"

# pcmanfm's own on-desktop menu would swallow the openbox right-click menu,
# so make it hand clicks to the window manager (show_wm_menu=1) and draw a
# plain dark background. Written for both standard profiles to be safe.
for _prof in default LXDE; do
  CONF_DIR="$HOME/.config/pcmanfm/$_prof"
  mkdir -p "$CONF_DIR"
  if [ ! -f "$CONF_DIR/pcmanfm.conf" ]; then
    cat > "$CONF_DIR/pcmanfm.conf" <<EOF
[Desktop]
wallpaper_mode=0
desktop_bg=#101418
desktop_fg=#ffffff
desktop_shadow=#000000
show_wm_menu=1

[pcmanfm]
EOF
  fi
done

# Иконки рабочего стола рисует idesk (pcmanfm на этом раннере НЕ показывает
# фон/иконки: его GTK2-конфиг молча игнорируется — проверено на скриншотах,
# фон оставался чёрным). idesk читает ~/.idesktop/*.lnk + ~/.ideskrc, поэтому
# те же ярлыки пишутся и туда (см. npm-hub/src/vnc-keepalive.js).
# Clickable launchers on the desktop - pcmanfm shows the icons of ~/Desktop
mkdir -p "$HOME/Desktop" "$HOME/Pictures"
launcher() {
  local name="${1:-}" exec="${2:-}" term="${3:-}" icon="${4:-}"
  local file="$HOME/Desktop/$name.desktop"
  cat > "$file" <<EOF
[Desktop Entry]
Name=$name
Comment=запуск с рабочего стола
Exec=$exec
Type=Application
Terminal=$term
Icon=${icon}
EOF
  chmod +x "$file"
}
# Базовые
launcher "Терминал"          "xterm"              true  "utilities-terminal"
launcher "Файловый менеджер" "pcmanfm"            false "system-file-manager"
if [ -n "$BROWSER" ]; then
  launcher "Браузер"          "$BROWSER"           false "web-browser"
  launcher "YouTube"         "$BROWSER https://www.youtube.com" false "youtube"
  launcher "GitHub"          "$BROWSER https://github.com"      false "github"
fi
if command -v pavucontrol >/dev/null 2>&1; then
  launcher "Звук"            "pavucontrol"        false "audio-volume-high"
fi
# Доп. ярлыки
launcher "Редактор (Geany)"  "geany 2>/dev/null || gedit 2>/dev/null || xterm -e nano" false "text-editor"
launcher "Hub папка"         "pcmanfm $HOME/hub-work" false "folder"
# Ярлык на сам Hub (откроет браузер на локальный хаб)
launcher "NPM Hub"           "${BROWSER:-xterm} http://127.0.0.1:8090" false "applications-internet"

# Обои — тёмный градиент + подпись. Если файл уже есть (его рисует
# vnc-keepalive.js, у него та же картинка + иконки), не трогаем.
WALL="$HOME/Pictures/wallpaper.png"
mkdir -p "$HOME/Pictures"
FONT=""
for _f in /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
          /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf \
          /usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf \
          /usr/share/fonts/TTF/DejaVuSans.ttf; do
  [ -f "$_f" ] && FONT="$_f" && break
done
if [ ! -s "$WALL" ]; then
  if command -v convert >/dev/null 2>&1 && [ -n "$FONT" ]; then
    convert -size "$RESOLUTION" gradient:'#0b0f14-#1a2a3e' \
      -font "$FONT" -gravity center \
      -fill '#58a6ff' -pointsize 86 -annotate +0-60 'NPM Hub' \
      -fill '#7d8590' -pointsize 30 -annotate +0+40 'Один экран для всего' \
      "$WALL" 2>/dev/null || true
  elif command -v convert >/dev/null 2>&1; then
    convert -size "$RESOLUTION" gradient:'#0b0f14-#1a2a3e' "$WALL" 2>/dev/null || true
  elif command -v python3 >/dev/null 2>&1; then
    # последний резерв: ровный тёмный цвет (пиксели, а не чёрный экран)
    python3 - "$WALL" "$RESOLUTION" <<'PYEOF' 2>/dev/null || true
import sys, zlib, struct
out, res = sys.argv[1], sys.argv[2]
w, h = (int(x) for x in res.split('x'))
raw = b''.join(b'\x00' + b'\x12\x1c\x28' * w for _ in range(h))
def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))
open(out, 'wb').write(png)
PYEOF
  fi
fi
[ -s "$WALL" ] || WALL=""
# Если не удалось — просто тёмный png через xsetroot позже
# Настроим pcmanfm чтобы показывал обои и иконки
for _prof in default LXDE; do
  CONF_DIR="$HOME/.config/pcmanfm/$_prof"
  mkdir -p "$CONF_DIR"
  # Перезапишем с обоями (без обоев — тёмный фон, но не пустая строка)
  cat > "$CONF_DIR/pcmanfm.conf" <<EOF
[Desktop]
wallpaper_mode=$([ -n "$WALL" ] && echo 1 || echo 0)
wallpaper=$WALL
desktop_bg=#101418
desktop_fg=#ffffff
desktop_shadow=#000000
show_wm_menu=1
desktop_sort=mtime

[pcmanfm]
EOF
done
# Попытка сразу поставить обои если pcmanfm уже может
if [ -f "$WALL" ]; then
  if command -v feh >/dev/null 2>&1; then feh --bg-scale "$WALL" 2>/dev/null || true; fi
  # В ФОНЕ и под timeout -k (pcmanfm игнорирует SIGTERM, без -k он висит вечно):
  # раньше он держал весь скрипт и openbox/x11vnc не стартовали — это и был
  # чёрный экран. Обои уже стоят через feh + pcmanfm.conf.
  ( timeout -k 3 8 pcmanfm --set-wallpaper "$WALL" >/dev/null 2>&1 || true ) &
else
  xsetroot -solid '#121c28' 2>/dev/null || true
fi

# openbox autostart: file manager on the desktop, a terminal, the taskbar and
# per-user audio (with a silent "null" sink so every app just works).
{
  echo '# zen-desktop autostart'
  if [ -n "$WALL" ] && [ -f "$WALL" ]; then
    echo "feh --bg-scale \"$WALL\" 2>/dev/null || timeout 12 pcmanfm --set-wallpaper \"$WALL\" 2>/dev/null || xsetroot -solid \"#101418\""
  else
    echo 'xsetroot -solid "#101418"'
  fi
  # idesk = фон + иконки (pcmanfm --desktop на этом раннере не рисует ничего)
  echo 'if command -v idesk >/dev/null 2>&1; then idesk >/dev/null 2>&1 & else pcmanfm --desktop >/dev/null 2>&1 & fi'
  echo 'xterm -geometry 100x26+60+90 -title "NPM Hub · терминал" >/dev/null 2>&1 &'
  echo 'tint2 >/dev/null 2>&1 &'
  echo '( timeout -k 3 8 pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1 || true ) &'
} > "$CFG_DIR/autostart"

# openbox runs ~/.config/openbox/autostart itself, no extra launches needed.
openbox >"$HUB_LOGS/openbox.log" 2>&1 &
sleep 1
# timeout -k: pulseaudio --start умеет висеть навсегда (проверено), а он стоял
# ПЕРЕД x11vnc — весь рабочий стол не поднимался.
timeout -k 3 8 pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1 || true
sleep 1

# Sanity: confirm the display actually renders (both X and the WM answered).
if ! xdpyinfo -display "$DISPLAY_NUM" >/dev/null 2>&1 && command -v xdpyinfo >/dev/null 2>&1; then
  err "Xvfb on $DISPLAY_NUM did not come up (see $HUB_LOGS/xvfb.log)"
fi
if ! command -v x11vnc >/dev/null 2>&1; then
  err "x11vnc not found"
fi

log "x11vnc -> $VNC_PORT"
# -wait/-defer собирают изменения в пачку (меньше мелких обновлений = плавнее
# кино), -threads отдаёт кодирование отдельному потоку.
x11vnc -display "$DISPLAY_NUM" -nopw -forever -shared -bg -localhost -rfbport "$VNC_PORT" \
  -noxdamage -wirecopyrect top -alwaysshared -wait 2 -defer 2 -threads >"$HUB_LOGS/x11vnc.log" 2>&1 || \
  x11vnc -display "$DISPLAY_NUM" -nopw -forever -shared -bg -localhost -rfbport "$VNC_PORT" \
  >"$HUB_LOGS/x11vnc.log" 2>&1

# noVNC via websockify (noVNC on Ubuntu ships /usr/share/novnc). If the
# package is missing, still usable through any VNC client on port VNC_PORT.
NOVNC_WEB=""
for d in /usr/share/novnc /usr/share/novnc/utils /usr/local/share/novnc; do
  [ -f "$d/vnc.html" ] && NOVNC_WEB="$d" && break
done
if [ -n "$NOVNC_WEB" ]; then
  log "noVNC -> $NOVNC_PORT (web $NOVNC_WEB)"
  websockify --web "$NOVNC_WEB" "$NOVNC_PORT" 127.0.0.1:"$VNC_PORT" >"$HUB_LOGS/websockify.log" 2>&1 &
  NOVNC_PID=$!
  sleep 2
else
  warn "noVNC html not found, serving VNC-only on $VNC_PORT"
fi

# Belt and braces: whatever happened above, the WM and the VNC server MUST be
# running before we report READY. A desktop without openbox/x11vnc still
# answers /vnc.html — that is how a «работает, но чёрный» screen is born.
if ! pgrep -x openbox >/dev/null 2>&1; then
  log "openbox не поднялся сам — запускаю"
  openbox >"$HUB_LOGS/openbox.log" 2>&1 &
  sleep 1
fi
if ! pgrep -f "x11vnc.*$DISPLAY_NUM" >/dev/null 2>&1; then
  log "x11vnc не поднялся сам — запускаю"
  x11vnc -display "$DISPLAY_NUM" -nopw -forever -shared -bg -localhost -rfbport "$VNC_PORT" \
    -noxdamage -wirecopyrect top -alwaysshared >"$HUB_LOGS/x11vnc.log" 2>&1 || \
    x11vnc -display "$DISPLAY_NUM" -nopw -forever -shared -bg -localhost -rfbport "$VNC_PORT" \
      >"$HUB_LOGS/x11vnc.log" 2>&1 || warn "x11vnc не стартовал"
fi
if pgrep -x idesk >/dev/null 2>&1; then :; elif command -v idesk >/dev/null 2>&1; then
  idesk >/dev/null 2>&1 & sleep 1
elif ! pgrep -x pcmanfm >/dev/null 2>&1; then
  pcmanfm --desktop >/dev/null 2>&1 & sleep 1
fi
# idesk рисует иконки окнами override-redirect: WM их не переставляет, и при
# перерисовке они оказываются ПОВЕРХ окна браузера (та самая «наложенность» на
# экране телефона). xwit умеет их опустить.
lower_idesk_windows() {
  local _ids _bases _b _w _n
  _ids=$(xwininfo -root -children 2>/dev/null | awk '/[0-9]+x64\+/{print $1}')
  [ -z "$_ids" ] && return 0
  _bases=""
  for _id in $_ids; do
    _b=$(printf '%#x' $(( 0x${_id#0x} & 0x3ff00000 )))
    case " $_bases " in *" $_b "*) ;; *) _bases="$_bases $_b" ;; esac
  done
  _n=0
  for _w in $(xwininfo -root -children 2>/dev/null | grep -oE '0x[0-9a-f]+' | sort -u); do
    _b=$(printf '%#x' $(( 0x${_w#0x} & 0x3ff00000 )))
    case " $_bases " in *" $_b "*) xwit -id "$_w" -lower 2>/dev/null && _n=$((_n+1));; esac
  done
  log "иконки стола опущены под окна: $_n (клиенты:$_bases)"
}
if command -v xwit >/dev/null 2>&1; then
  lower_idesk_windows || true
fi

pgrep -x tint2 >/dev/null 2>&1 || { tint2 >/dev/null 2>&1 & }

# Wait until one of them answers (noVNC preferred, VNC fallback).
for _ in $(seq 1 20); do
  if curl -sf -m 2 "http://127.0.0.1:$NOVNC_PORT/vnc.html" >/dev/null 2>&1; then
    echo "READY novnc=$NOVNC_PORT vnc=$VNC_PORT display=$DISPLAY_NUM"
    exit 0
  fi
  if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$VNC_PORT" 2>/dev/null; then
    echo "READY vnc=$VNC_PORT novnc=off display=$DISPLAY_NUM"
    exit 0
  fi
  sleep 1
done

err "desktop VNC did not come up (see $HUB_LOGS/x11vnc.log)"