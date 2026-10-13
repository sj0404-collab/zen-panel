#!/usr/bin/env python3
"""EasyOCR over a folder of page images (for comparison with NormCap).

Usage:
  python easyocr_ocr.py <pages_dir> <out_dir>
"""

from __future__ import annotations

import argparse
import glob
import json
import os
from pathlib import Path

IMG_EXT = (".jpg", ".jpeg", ".png", ".webp", ".bmp")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pages_dir")
    ap.add_argument("out_dir")
    args = ap.parse_args()

    import easyocr  # imported late so the step can be skipped cheaply

    reader = easyocr.Reader(["ru", "en"], gpu=False, verbose=False)

    pages = sorted(
        p
        for p in glob.glob(os.path.join(args.pages_dir, "*"))
        if p.lower().endswith(IMG_EXT)
    )
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    txt = (out / "transcript.txt").open("w", encoding="utf-8")
    result = {}

    for i, p in enumerate(pages, 1):
        base = os.path.basename(p)
        lines = reader.readtext(p, detail=0, paragraph=False)
        text = "\n".join(lines)
        txt.write(f"===== {base} =====\n{text}\n\n")
        txt.flush()
        result[base] = text
        print(f"[{i}/{len(pages)}] {base}: {len(lines)} lines", flush=True)

    txt.close()
    (out / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("[i] done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
