#!/usr/bin/env python3
"""NormCap-based OCR over a folder of manga page images.

Uses NormCap's own detection layer (normcap.detection.ocr) as a library:
  - NormCap's enhance.preprocess() for upscaling (resize_factor)
  - NormCap's tesseract wrapper (perform_ocr -> TSV word/line metadata)
  - NormCap's OcrResult.add_linebreaks() for raw text reconstruction

Runs an ensemble of (resize_factor, psm) configs per page and keeps, for every
page, the config with the highest mean word confidence. Output is verbatim OCR —
no correction, no invented words.

Usage:
  python normcap_ocr.py <pages_dir> <out_dir> [--tess-cmd PATH] [--tessdata DIR]
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sys
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtGui import QGuiApplication, QImage  # noqa: E402

from normcap.detection.ocr import tesseract  # noqa: E402
from normcap.detection.ocr.enhance import preprocess  # noqa: E402
from normcap.detection.ocr.models import OEM, PSM, OcrResult, TessArgs  # noqa: E402

# (name, resize_factor, psm, lang)
CONFIGS = [
    ("r2_psm3", 2.0, PSM.AUTO, "rus"),
    ("r3_psm3", 3.0, PSM.AUTO, "rus"),
    ("r4_psm3", 4.0, PSM.AUTO, "rus"),
    ("r3_psm6", 3.0, PSM.SINGLE_BLOCK, "rus"),
    ("r3_psm11", 3.0, PSM.SPARSE_TEXT, "rus"),
    ("r3_psm12", 3.0, PSM.SPARSE_TEXT_OSD, "rus"),
]
IMG_EXT = (".jpg", ".jpeg", ".png", ".webp", ".bmp")


def find_tesseract(explicit: str | None) -> str:
    if explicit and Path(explicit).exists():
        return explicit
    if env := os.environ.get("TESSERACT_CMD"):
        return env
    if found := shutil.which("tesseract"):
        return found
    candidates = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        "/usr/bin/tesseract",
        "/usr/local/bin/tesseract",
    ]
    for c in candidates:
        if Path(c).exists():
            return c
    raise FileNotFoundError("tesseract binary not found")


def _download(url: str, target: Path) -> None:
    import urllib.request

    print(f"[i] downloading {url}", flush=True)
    urllib.request.urlretrieve(url, target)


def ensure_lang(tess_cmd: str, tessdata: str | None, lang: str) -> str | None:
    """Make sure `lang` (+ osd) traineddata is available; return tessdata dir."""
    langs: list[str] = []
    try:
        langs = tesseract.get_languages(tess_cmd, tessdata)
    except Exception as exc:  # noqa: BLE001
        print(f"[w] --list-langs failed: {exc}", flush=True)
    if lang in langs:
        print(f"[i] '{lang}' already available in tesseract default tessdata", flush=True)
        return tessdata
    # Tesseract can't find the language: drop traineddata into a local dir and
    # point Tesseract at it via --tessdata-dir. `osd` is needed by psm 12.
    local = Path(tessdata) if tessdata else Path.cwd() / "tessdata"
    local.mkdir(parents=True, exist_ok=True)
    for code in (lang, "osd"):
        target = local / f"{code}.traineddata"
        if not target.exists():
            url = f"https://github.com/tesseract-ocr/tessdata_fast/raw/main/{code}.traineddata"
            try:
                _download(url, target)
            except Exception as exc:  # noqa: BLE001
                print(f"[w] could not download {code}: {exc}", flush=True)
    return str(local)


def ocr_page(img_path: str, tess_cmd: str, tessdata: str | None) -> tuple[str, str, tuple]:
    img = QImage(img_path)
    if img.isNull():
        print(f"[w] {img_path}: QImage failed to load", flush=True)
        return "NONE", "", (0, 0.0, 0)
    best = None
    for name, rz, psm, lang in CONFIGS:
        try:
            im = preprocess(img, resize_factor=rz, padding=0)
            args = TessArgs(tessdata, lang, OEM.DEFAULT, psm).as_list()
            words = tesseract.perform_ocr(tesseract_bin_path=tess_cmd, image=im, args=args)
            res = OcrResult(None, words, im)
        except Exception as exc:  # noqa: BLE001
            print(f"[w] {img_path} {name}: {type(exc).__name__}: {exc}", flush=True)
            continue
        good = [w for w in res.words if w.get("conf", 0) >= 50 and len(w["text"].strip()) >= 2]
        # Rank by confidence first: sparse PSMs (11/12) win on word count but
        # drag in art noise. Among configs with a near-equal mean confidence,
        # prefer the one that read more real words.
        score = (round(res.mean_conf, 1), len(good), res.num_chars)
        if best is None or score > best[2]:
            best = (name, res.text, score)
    if best is None:
        return "NONE", "", (0, 0.0, 0)
    return best[0], best[1], best[2]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pages_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--tess-cmd", default=None)
    ap.add_argument("--tessdata", default=None)
    args = ap.parse_args()

    app = QGuiApplication.instance() or QGuiApplication(sys.argv)

    tess_cmd = find_tesseract(args.tess_cmd)
    tessdata = ensure_lang(tess_cmd, args.tessdata, "rus")
    print(f"[i] tesseract: {tess_cmd}", flush=True)
    print(f"[i] tessdata : {tessdata}", flush=True)

    pages = sorted(
        p
        for p in glob.glob(os.path.join(args.pages_dir, "*"))
        if p.lower().endswith(IMG_EXT)
    )
    print(f"[i] pages    : {len(pages)}", flush=True)

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    txt = (out / "transcript.txt").open("w", encoding="utf-8")
    log = (out / "config_log.tsv").open("w", encoding="utf-8")
    result = {}

    for i, p in enumerate(pages, 1):
        name, text, score = ocr_page(p, tess_cmd, tessdata)
        base = os.path.basename(p)
        txt.write(f"===== {base} =====\n{text}\n\n")
        txt.flush()
        log.write(f"{base}\t{name}\t{score}\n")
        log.flush()
        result[base] = {"config": name, "score": list(score), "text": text}
        print(f"[{i}/{len(pages)}] {base}: {name} {score}", flush=True)

    txt.close()
    log.close()
    (out / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("[i] done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
