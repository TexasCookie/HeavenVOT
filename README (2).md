# Local Video Translate

Личный закадр YouTube watch VOD в Edge: расширение + локальный хост. Модели не в браузере. Облачного ИИ нет.

## Установка

1. `powershell -ExecutionPolicy Bypass -File setup.ps1` (venv, pip, NLLB, реестр хоста)
2. Либо вручную: `.venv\Scripts\pip install -r requirements.txt` и `python native-host\download_models.py`
3. Edge → `edge://extensions` → Developer mode → Load unpacked → эта папка проекта (где лежит `manifest.json`). Можно указать и вложенную `extension`.

Кнопка «Перевод» на обычном `watch.youtube.com`. Попап: язык (RU/EN) и громкость оригинала.

Без пакета переводчика хост поднимается, но старт на чужом языке вернёт ошибку (тесты подставляют переводчик). Синтезатор-заглушка всегда есть.

## Тесты

```
.venv\Scripts\python -m pytest -q
node tests\test_policy.js
```
