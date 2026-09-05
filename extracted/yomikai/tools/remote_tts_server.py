#!/usr/bin/env python3
"""Локальный TTS-сервер нейроголосов для Yomikai (yomihon-custom).

Нейросетевой синтез (sherpa-onnx + русские Piper-голоса) вынесен из APK сюда:
на телефоне его ломали minify/ABI/память, а на ПК или ранере он стабилен.
Приложение шлёт предложения на POST /tts и проигрывает полученный wav.

Запуск (ПК рядом с телефоном, одна сеть Wi-Fi):
    pip install sherpa-onnx
    python tools/remote_tts_server.py --host 0.0.0.0 --port 8788

В приложении: Настройки озвучки → движок «🖥 Сервер» → адрес
    http://<ip-вашего-ПК>:8788

Модели скачиваются один раз в ~/.cache/yomikai-tts/ (те же irina/dmitri/ruslan,
что раньше жили в APK). Голос выбирается по полу: voice=female|male|auto|id.
"""
import argparse
import json
import os
import re
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = {
    "irina": ("vits-piper-ru_RU-irina-medium", "female"),
    "dmitri": ("vits-piper-ru_RU-dmitri-medium", "male"),
    "ruslan": ("vits-piper-ru_RU-ruslan-medium", "male"),
}
BASE = ("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/")

_tts_lock = threading.Lock()
_tts = {}  # id -> OfflineTts


def model_dir(cache: str, vid: str) -> str:
    name = MODELS[vid][0]
    d = os.path.join(cache, name)
    if not os.path.isfile(os.path.join(d, name + ".onnx")):
        os.makedirs(d, exist_ok=True)
        url = BASE + name + ".tar.bz2"
        print(f"[tts] качаю {vid}: {url}")
        tmp = d + ".tar.bz2"
        urllib.request.urlretrieve(url, tmp)
        import tarfile
        with tarfile.open(tmp) as tf:
            tf.extractall(cache)
        os.remove(tmp)
    return d


def get_tts(cache: str, vid: str):
    with _tts_lock:
        if vid not in _tts:
            import sherpa_onnx
            d = model_dir(cache, vid)
            name = MODELS[vid][0]
            _tts[vid] = sherpa_onnx.OfflineTts(
                sherpa_onnx.OfflineTtsConfig(
                    model=sherpa_onnx.OfflineTtsModelConfig(
                        vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                            model=os.path.join(d, name + ".onnx"),
                            lexicon=os.path.join(d, "lexicon.txt"),
                            tokens=os.path.join(d, "tokens.txt"),
                            data_dir=os.path.join(d, "espeak-ng-data"),
                        ),
                        num_threads=4,
                    ),
                )
            )
        return _tts[vid]


def pick_voice(requested: str) -> str:
    r = (requested or "auto").strip().lower()
    if r in MODELS:
        return r
    if r in ("female", "woman", "female_voice"):
        return "irina"
    if r in ("male", "man"):
        return "dmitri"
    return "irina"


def split_sentences(text: str):
    parts = re.split(r"(?<=[.!?…])\s+", text.strip())
    return [p for p in (x.strip() for x in parts) if p]


class Handler(BaseHTTPRequestHandler):
    cache = os.path.expanduser("~/.cache/yomikai-tts")

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/voices", ""):
            self._send(200, json.dumps(
                {"voices": [{"id": k, "gender": g} for k, (_, g) in MODELS.items()]},
                ensure_ascii=False).encode(), "application/json")
        else:
            self._send(404, b'{"error":"not found"}', "application/json")

    def do_POST(self):
        if self.path.rstrip("/") != "/tts":
            self._send(404, b'{"error":"not found"}', "application/json")
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(length) or b"{}")
            text = (req.get("text") or "").strip()
            speed = float(req.get("speed") or 1.0)
            vid = pick_voice(req.get("voice"))
            if not text:
                self._send(400, b'{"error":"empty text"}', "application/json")
                return
            tts = get_tts(self.cache, vid)
            # Длинные тексты режем на предложения: ответ быстрее и стабильнее.
            samples = []
            sample_rate = None
            for sentence in split_sentences(text)[:24]:
                aud = tts.generate(sentence, sid=0, speed=speed)
                samples.extend(aud.samples)
                sample_rate = aud.sample_rate
            if not samples or not sample_rate:
                self._send(500, b'{"error":"empty synthesis"}', "application/json")
                return
            import io
            import struct
            import wave
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(sample_rate)
                clipped = [int(max(-32768, min(32767, s * 32767))) for s in samples]
                w.writeframes(struct.pack("<%dh" % len(clipped), *clipped))
            self._send(200, buf.getvalue(), "audio/wav")
        except Exception as e:  # noqa: BLE001 — сервер не должен падать на реплике
            print("[tts] ошибка:", e)
            self._send(500, json.dumps({"error": str(e)}).encode(), "application/json")

    def log_message(self, fmt, *args):
        print("[tts]", fmt % args)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument("--cache", default=os.path.expanduser("~/.cache/yomikai-tts"))
    args = ap.parse_args()
    Handler.cache = args.cache
    os.makedirs(args.cache, exist_ok=True)
    print(f"[tts] сервер на http://{args.host}:{args.port} (кэш {args.cache})")
    print("[tts] в приложении: движок «Сервер» → этот адрес")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    sys.exit(main())
