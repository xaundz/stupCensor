# stupidCensor

Legacy script-аддон PulseSync для Яндекс Музыки: поиск альтернативных записей и облачная подмена цензурированных треков через публичный GitHub-репозиторий пользователя.

Автор:  **Xaunds** · версия **1.1.0**.

## Возможности

- Пункты меню трека: **«Найти без цензуры»** и **«stupidCensor: открыть»**.
- Автопоиск и автосохранение уверенных совпадений; при сомнении — подтверждение в панели.
- Пометка **SC** у треков с активной заменой.
- Поиск через GitHub Actions (`workflow_dispatch`) и yt-dlp: YouTube + SoundCloud.
- Поиск только по метаданным: аудио не скачивается и не публикуется до подтверждения.
- Публикация выбранного файла в GitHub Releases и запись в `list.json`.
- Автоматическая регистрация подмен по ID трека.
- Отмена заданий, ориентировочное время и статусы без ручного обновления.
- Ручное добавление по прямой HTTPS-ссылке.
- Библиотека, настройки GitHub и режим чтения без токена.
- Публичный репозиторий и режим чтения без токена.

## Быстрый старт

```bash
yarn install
yarn typecheck
yarn test:worker
yarn build:legacy
```

Результат: `dist/stupid-censor/` и архив `dist/stupid-censor.pext`. Установите архив через интерфейс PulseSync (импорт `.pext`) или скопируйте папку `dist/stupid-censor/` в каталог аддонов PulseSync. После установки включите аддон в списке и перезапустите Яндекс Музыку.

Перед использованием:

1. Создайте **публичный** GitHub-репозиторий.
2. Скопируйте в его корень:
   - `.github/workflows/uncensor-cloud.yml`;
   - `cloud/uncensor_worker.py`;
   - `cloud/requirements.txt`;
   - пустой `list.json` (пример: `list.example.json`).
3. Включите Actions и workflow, который использует файл `.github/workflows/uncensor-cloud.yml`, затем разрешите **Settings → Actions → General → Workflow permissions → Read and write permissions**.
4. Создайте fine-grained token: **Contents — Read and write**, **Actions — Read and write**, **Metadata — Read**.
5. Откройте меню трека (три точки) → **«stupidCensor: открыть»** → вкладка **«GitHub»**, укажите `владелец/репозиторий` и токен.
6. В меню трека выберите **«Найти без цензуры»**. Уверенное совпадение аддон сохранит сам, иначе откроет панель для подтверждения.

Подробная инструкция: `setup-ru.html` (в корне архива и в установленной папке аддона).

## Архитектура

```text
stupidCensor (legacy script addon)
  ├─ POST /actions/workflows/uncensor-cloud.yml/dispatches  (token)
  ├─ GET  jobs/<jobId>.json                                  (статус)
  ├─ GET  list.json                                          (индекс)
  └─ <audio> GitHub Releases                                 (воспроизведение)

GitHub Actions (в репозитории пользователя)
  ├─ search  → yt-dlp metadata → jobs/<id>.json
  ├─ confirm → yt-dlp download → ffmpeg → release library → list.json
  ├─ manual  → HTTPS download → ffmpeg → release library → list.json
  ├─ toggle  → list.json
  └─ remove  → list.json
```

- `jobs/<jobId>.json` — публичный статус задания.
- `list.json` — индекс замен, читается аддоном.
- Релиз `library` — постоянные аудиофайлы для подмен.
- Аудиофайлы не удаляются при удалении связи; удаляется только запись индекса.

## Структура проекта

- `src/legacy.tsx` — точка входа legacy script-аддона.
- `src/legacy/` — Shadow DOM UI, `AddonApi` shim, локальные настройки.
- `src/store.ts` — состояние, GitHub API, задания, библиотека.
- `src/components/` — панель, трек, библиотека, задания, настройки.
- `scripts/build-legacy.mjs` — сборка `.pext` и метаданных.
- `src/main.tsx` — старый WebHost-вход для справки; legacy-сборка его не использует.
- `src/lib/github.ts` — REST-клиент GitHub.
- `src/lib/library.ts` — разбор `list.json` и регистрация подмен.
- `src/lib/tracks.ts` — метаданные трека.
- `cloud/uncensor_worker.py` — обработчик GitHub Actions.
- `.github/workflows/uncensor-cloud.yml` — workflow.
- `tests/worker/` — unit-тесты worker.
- `scripts/make-assets.py` — генерация logo/banner.
- `setup-ru.html` — инструкция для пользователя.

## Проверка

```bash
yarn typecheck
yarn test:worker
yarn build:legacy
```

Проверки выполняются локально; живой GitHub Actions нужно проверить в своём репозитории.

## Безопасность и ограничения

- Приватные репозитории не подходят: ссылки на аудио должны быть публичными.
- Токен не должен попадать в `list.json`, workflow inputs, архивы и публичные файлы.
- Автоматическое совпадение названия/длительности не доказывает отсутствие цензуры. Проверяйте источник перед публикацией.
- yt-dlp с IP GitHub Actions может получать отказы YouTube/SoundCloud.
- Аддон не обходит авторизацию, DRM или платный доступ.
- Публикуя аудио, пользователь отвечает за соблюдение авторских прав и правил GitHub. Безопаснее публиковать только записи, права на которые подтверждены.
- Старые версии в `library` не чистятся автоматически. Удаляйте ненужные assets вручную.

## Лицензия

Исходный шаблон распространяется по **PulseSync Addon Development License 1.1**: [русский текст](./LICENSE.ru.md) · [English](./LICENSE). При расхождениях применяется русская версия в пределах, допускаемых законом.

Copyright © 2026 xaunds. Все права защищены.
