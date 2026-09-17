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
# Prints "READY" on stdout when noVNC (or VNC) is answering, else exit 1.
set -uo pipefail

DISPLAY_NUM="${VNC_DISPLAY:-:99}"
RESOLUTION="${VNC_RESOLUTION:-1920x1080}"
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
  x11-utils x11-xserver-utils pcmanfm pulseaudio pavucontrol"
if ! command -v Xvfb >/dev/null 2>&1; then
  warn "installing desktop stack..."
  sudo apt-get update -qq
  # shellcheck disable=SC2086
  sudo apt-get install -y -qq $INSTALL_PKGS || true
fi

pkill -f "Xvfb $DISPLAY_NUM" 2>/dev/null || true
pkill -f "x11vnc.*$DISPLAY_NUM" 2>/dev/null || true
pkill -f "websockify.*$NOVNC_PORT" 2>/dev/null || true
sleep 1

SCR="${RESOLUTION}x24"
log "Xvfb $DISPLAY_NUM ($SCR)"
Xvfb "$DISPLAY_NUM" -screen 0 "$SCR" -nolisten tcp >"$HUB_LOGS/xvfb.log" 2>&1 &
XVFB_PID=$!
export DISPLAY=$DISPLAY_NUM
sleep 2

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

# Clickable launchers on the desktop - pcmanfm shows the icons of ~/Desktop,
# so the file manager, terminal, browser and audio mixer are one click away.
mkdir -p "$HOME/Desktop"
launcher() {
  local name="$1" exec="$2" term="$3" file="$HOME/Desktop/$name.desktop"
  cat > "$file" <<EOF
[Desktop Entry]
Name=$name
Comment=запуск с рабочего стола
Exec=$exec
Type=Application
Terminal=$term
EOF
  chmod +x "$file"
}
launcher "Терминал"          "xterm"              true
launcher "Файловый менеджер" "pcmanfm"            false
if [ -n "$BROWSER" ]; then
  launcher "Браузер" "$BROWSER" false
fi
if command -v pavucontrol >/dev/null 2>&1; then
  launcher "Звук" "pavucontrol" false
fi

# openbox autostart: file manager on the desktop, a terminal, the taskbar and
# per-user audio (with a silent "null" sink so every app just works).
{
  echo '# zen-desktop autostart'
  echo 'xsetroot -solid "#101418"'
  echo 'pcmanfm --desktop >/dev/null 2>&1 &'
  echo 'xterm -geometry 160x40+40+40 -title "Hub Linux Desktop" >/dev/null 2>&1 &'
  echo 'tint2 >/dev/null 2>&1 &'
  echo 'pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1 &'
} > "$CFG_DIR/autostart"

# openbox runs ~/.config/openbox/autostart itself, no extra launches needed.
openbox >"$HUB_LOGS/openbox.log" 2>&1 &
sleep 1
pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1 || true
sleep 1

# Sanity: confirm the display actually renders (both X and the WM answered).
if ! xdpyinfo -display "$DISPLAY_NUM" >/dev/null 2>&1 && command -v xdpyinfo >/dev/null 2>&1; then
  err "Xvfb on $DISPLAY_NUM did not come up (see $HUB_LOGS/xvfb.log)"
fi
if ! command -v x11vnc >/dev/null 2>&1; then
  err "x11vnc not found"
fi

log "x11vnc -> $VNC_PORT"
x11vnc -display "$DISPLAY_NUM" -nopw -forever -shared -bg -rfbport "$VNC_PORT" \
  -noxdamage -wirecopyrect top -alwaysshared >"$HUB_LOGS/x11vnc.log" 2>&1 || \
  x11vnc -display "$DISPLAY_NUM" -nopw -forever -shared -bg -rfbport "$VNC_PORT" \
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