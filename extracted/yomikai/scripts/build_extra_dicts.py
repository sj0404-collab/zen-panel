import json
import zipfile
import os

dict_dir = "/home/user/yomihon/dictionaries"
os.makedirs(dict_dir, exist_ok=True)

# 1. Russian Explanatory Dictionary (Yomitan format)
ru_index = {
    "title": "Толковый словарь русского языка",
    "format": 3,
    "revision": "2026.08.15",
    "sequenced": True,
    "author": "Yomihon",
    "description": "Толковый словарь терминов и слов русского языка.",
    "attribution": "Yomihon Dictionary Collection",
    "sourceLanguage": "ru",
    "targetLanguage": "ru",
    "isUpdatable": False,
    "downloadUrl": "https://github.com/sj0404-collab/yomihon-custom/raw/main/dictionaries/Russian_Explanatory.zip"
}

ru_terms = [
    ["привет", "привет", "", "", 0, ["Приветствие, дружеское обращение при встрече."], 0, ""],
    ["мир", "мир", "", "", 0, ["Состояние спокойствия и согласия; Земной шар, вселенная."], 0, ""],
    ["язык", "язык", "", "", 0, ["Система знаков, используемая для общения и выражения мыслей."], 0, ""],
    ["словарь", "словарь", "", "", 0, ["Собрание слов с их объяснениями или переводом на другой язык."], 0, ""],
    ["книга", "книга", "", "", 0, ["Печатное или рукописное издание в виде сшитых листов."], 0, ""],
    ["знание", "знание", "", "", 0, ["Результат познания, проверенный практикой."], 0, ""],
    ["чтение", "чтение", "", "", 0, ["Восприятие и понимание прочитанного текста."], 0, ""]
]

ru_zip_path = os.path.join(dict_dir, "Russian_Explanatory.zip")
with zipfile.ZipFile(ru_zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr("index.json", json.dumps(ru_index, ensure_ascii=False, indent=2))
    zf.writestr("term_bank_1.json", json.dumps(ru_terms, ensure_ascii=False, indent=2))

print(f"Created {ru_zip_path}")

# 2. Latin to Cyrillic Dictionary (Yomitan format)
lat_index = {
    "title": "Латиница в Кириллицу (Translit)",
    "format": 3,
    "revision": "2026.08.15",
    "sequenced": True,
    "author": "Yomihon",
    "description": "Словарь и таблица транслитерации латинских символов и слов в кириллицу.",
    "attribution": "Yomihon Dictionary Collection",
    "sourceLanguage": "en",
    "targetLanguage": "ru",
    "isUpdatable": False,
    "downloadUrl": "https://github.com/sj0404-collab/yomihon-custom/raw/main/dictionaries/Latin_to_Cyrillic.zip"
}

lat_terms = [
    ["privet", "привет", "", "", 0, ["Конвертация латиницы: **привет** (приветствие)"], 0, ""],
    ["spasibo", "спасибо", "", "", 0, ["Конвертация латиницы: **спасибо** (благодарность)"], 0, ""],
    ["mir", "мир", "", "", 0, ["Конвертация латиницы: **мир** (мир/вселенная)"], 0, ""],
    ["dobro", "добро", "", "", 0, ["Конвертация латиницы: **добро**"], 0, ""],
    ["manga", "манга", "", "", 0, ["Конвертация латиницы: **манга**"], 0, ""],
    ["yomihon", "ёмихон", "", "", 0, ["Конвертация латиницы: **ёмихон**"], 0, ""],
    ["a", "а", "", "", 0, ["Буква кириллицы: **а**"], 0, ""],
    ["b", "б", "", "", 0, ["Буква кириллицы: **б**"], 0, ""],
    ["v", "в", "", "", 0, ["Буква кириллицы: **в**"], 0, ""],
    ["g", "г", "", "", 0, ["Буква кириллицы: **г**"], 0, ""],
    ["d", "д", "", "", 0, ["Буква кириллицы: **д**"], 0, ""],
    ["e", "е", "", "", 0, ["Буква кириллицы: **е**"], 0, ""],
    ["zh", "ж", "", "", 0, ["Буква кириллицы: **ж**"], 0, ""],
    ["z", "з", "", "", 0, ["Буква кириллицы: **з**"], 0, ""],
    ["i", "и", "", "", 0, ["Буква кириллицы: **и**"], 0, ""],
    ["k", "к", "", "", 0, ["Буква кириллицы: **к**"], 0, ""],
    ["l", "л", "", "", 0, ["Буква кириллицы: **л**"], 0, ""],
    ["m", "м", "", "", 0, ["Буква кириллицы: **м**"], 0, ""],
    ["n", "н", "", "", 0, ["Буква кириллицы: **н**"], 0, ""],
    ["o", "о", "", "", 0, ["Буква кириллицы: **о**"], 0, ""],
    ["p", "п", "", "", 0, ["Буква кириллицы: **п**"], 0, ""],
    ["r", "р", "", "", 0, ["Буква кириллицы: **р**"], 0, ""],
    ["s", "с", "", "", 0, ["Буква кириллицы: **с**"], 0, ""],
    ["t", "т", "", "", 0, ["Буква кириллицы: **т**"], 0, ""],
    ["u", "у", "", "", 0, ["Буква кириллицы: **у**"], 0, ""],
    ["f", "ф", "", "", 0, ["Буква кириллицы: **ф**"], 0, ""],
    ["kh", "х", "", "", 0, ["Буква кириллицы: **х**"], 0, ""],
    ["ts", "ц", "", "", 0, ["Буква кириллицы: **ц**"], 0, ""],
    ["ch", "ч", "", "", 0, ["Буква кириллицы: **ч**"], 0, ""],
    ["sh", "ш", "", "", 0, ["Буква кириллицы: **ш**"], 0, ""],
    ["shch", "щ", "", "", 0, ["Буква кириллицы: **щ**"], 0, ""],
    ["yu", "ю", "", "", 0, ["Буква кириллицы: **ю**"], 0, ""],
    ["ya", "я", "", "", 0, ["Буква кириллицы: **я**"], 0, ""]
]

lat_zip_path = os.path.join(dict_dir, "Latin_to_Cyrillic.zip")
with zipfile.ZipFile(lat_zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr("index.json", json.dumps(lat_index, ensure_ascii=False, indent=2))
    zf.writestr("term_bank_1.json", json.dumps(lat_terms, ensure_ascii=False, indent=2))

print(f"Created {lat_zip_path}")
