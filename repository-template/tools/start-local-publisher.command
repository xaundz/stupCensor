#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
    print "Не найден python3. Установите Python 3.11 или новее."
    exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
    print "Не найден ffmpeg. Установите его командой: brew install ffmpeg"
    exit 1
fi
if [[ ! -d .venv ]]; then
    print "Первый запуск: устанавливаю Python-зависимости…"
    python3 -m venv .venv
    .venv/bin/python -m pip install --disable-pip-version-check -r requirements-local.txt
fi

BROWSER="${STUPIDCENSOR_BROWSER:-chrome}"
REPO="${STUPIDCENSOR_REPO:-xaundz/stupidcensor-cloud}"
exec .venv/bin/python local_publisher.py --repo "${REPO}" --cookies-from-browser "${BROWSER}" "$@"
