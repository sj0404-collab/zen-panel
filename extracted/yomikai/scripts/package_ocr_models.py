import os
import urllib.request
import tarfile
import hashlib

ocr_dir = "/home/user/yomihon/ocr_models"
os.makedirs(ocr_dir, exist_ok=True)

models = [
    {
        "name": "manga_ocr_float32.tar.xz",
        "files": [
            ("bluolightning/manga-ocr-tflite", "mocr_2025_decoder_float32.tflite", "decoder.tflite"),
            ("bluolightning/manga-ocr-tflite", "mocr_2025_encoder_fp32.tflite", "encoder.tflite"),
            ("bluolightning/manga-ocr-tflite", "mocr_2025_embeddings_float32.bin", "embeddings.bin")
        ]
    },
    {
        "name": "manga_ocr_fast_fp16.tar.xz",
        "files": [
            ("bluolightning/manga-ocr-mobile", "v1_fp16/decoder.tflite", "decoder_fast.tflite"),
            ("bluolightning/manga-ocr-mobile", "v1_fp16/encoder.tflite", "encoder_fast.tflite")
        ]
    },
    {
        "name": "yolo_panel_detector.tar.xz",
        "files": [
            ("leoxs22/manga-panel-detector-yolo26n", "manga_panel_detector_int8.tflite", "panel_detector.tflite")
        ]
    }
]

print("Downloading and creating .tar.xz OCR model packages...")

for model in models:
    archive_path = os.path.join(ocr_dir, model["name"])
    print(f"Creating {archive_path}...")
    
    temp_files = []
    for repo, remote_path, local_name in model["files"]:
        url = f"https://huggingface.co/{repo}/resolve/main/{remote_path}"
        temp_dest = os.path.join(ocr_dir, local_name)
        print(f"  Downloading {url} -> {temp_dest}...")
        urllib.request.urlretrieve(url, temp_dest)
        temp_files.append((temp_dest, local_name))
    
    with tarfile.open(archive_path, "w:xz") as tar:
        for file_path, arcname in temp_files:
            tar.add(file_path, arcname=arcname)
            os.remove(file_path)
            
    print(f"Successfully generated {archive_path} ({os.path.getsize(archive_path)} bytes)")

print("All OCR model .tar.xz packages created!")
