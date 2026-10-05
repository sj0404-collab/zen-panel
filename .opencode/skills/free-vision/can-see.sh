#!/usr/bin/env bash
# Какие модели в этом конфиге умеют видеть, и умеет ли модель, на которой ты сейчас.
#
#   ./can-see.sh              → список vision-моделей (provider/model, по одной)
#   ./can-see.sh <model-id>   → exit 0 если модель принимает изображения
#
# Ответ берётся из resolved-конфига opencode, где у каждой модели есть флаг
# attachment. Это проверка факта, а не догадка: раньше агент на вопрос «что на
# скрине» всегда нырял в curl к Kilo/OVH, даже когда сам был запущен на
# модели с attachment: true, то есть картинку видел и так.
#
# Exit 1 = модель текстовая. Это НЕ ошибка: значит, делегируй вижн-субагенту.
set -uo pipefail

emit() {
  python3 - "$@" <<'PY'
import json, subprocess, sys, os

WANT = (sys.argv[1] if len(sys.argv) > 1 else "").strip()

def walk(cfg):
    out = []
    for pname, p in (cfg.get("provider") or {}).items():
        for mid, m in (p.get("models") or {}).items():
            if isinstance(m, dict) and m.get("attachment"):
                out.append(f"{pname}/{mid}")
    return out

models = []
# 1. The resolved config is the truth: it merges the project and the global file
#    and already knows which providers are enabled.
try:
    r = subprocess.run(["opencode", "debug", "config"], capture_output=True,
                       text=True, timeout=60)
    if r.returncode == 0 and r.stdout.strip():
        models = walk(json.loads(r.stdout))
except Exception:
    pass

# 2. opencode may be missing, slow, or refusing to start on a broken config. The
#    config files still answer the question, so fall back rather than guessing.
if not models:
    paths = []
    for base in (os.environ.get("HUB_WORK_DIR") or "", os.getcwd()):
        if base:
            paths += [os.path.join(base, "opencode.json"),
                      os.path.join(base, "opencode.jsonc"),
                      os.path.join(base, ".opencode", "opencode.json")]
    for p in ("opencode.json", "opencode.jsonc"):
        paths.append(os.path.join(os.path.expanduser("~/.config/opencode"), p))
    merged = {}
    for p in paths:
        try:
            raw = open(p, encoding="utf-8").read()
            # jsonc: strip // line comments and /* */ blocks outside strings is
            # overkill here; these files only use // lines.
            raw = "\n".join(l for l in raw.splitlines()
                            if not l.lstrip().startswith("//"))
            cfg = json.loads(raw)
        except Exception:
            continue
        for pn, pv in (cfg.get("provider") or {}).items():
            merged.setdefault(pn, {}).setdefault("models", {}).update(pv.get("models") or {})
    models = walk({"provider": merged})

models = sorted(set(models))
if not WANT:
    print("\n".join(models))
    sys.exit(0)

# Accept the bare id too: agents know "mimo-v2-omni-free" more often than the
# fully qualified "opencode/mimo-v2-omni-free".
hit = any(WANT == m or WANT == m.split("/", 1)[1] for m in models)
sys.exit(0 if hit else 1)
PY
}

emit "$@"