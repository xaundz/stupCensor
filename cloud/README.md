# Uncensor Cloud: облачная часть

Эта папка и `.github/workflows/uncensor-cloud.yml` размещаются в **публичном** GitHub-репозитории пользователя. Аддон не хранит аудио у себя: он запускает workflow, читает публичный индекс и скачивает аудио только для выбранной записи.

## Состав репозитория

```text
list.json
.github/workflows/uncensor-cloud.yml
cloud/uncensor_worker.py
cloud/requirements.txt
```

`list.json` можно начать с пустого объекта:

```json
{
  "schema": 1,
  "name": "Uncensor Cloud",
  "tracks": {}
}
```

Если файла нет, worker создаст его при первой публикации. Но раздел «Библиотека» до этого будет пустым.

## Workflow

Workflow `Uncensor Cloud` запускается только через `workflow_dispatch` с входными параметрами:

| Параметр | Назначение |
| --- | --- |
| `action` | `search`, `confirm`, `manual`, `toggle`, `remove` |
| `job_id` | UUID задания, создаётся аддоном |
| `track_id` | ID трека Яндекс Музыки |
| `artist`, `title`, `duration` | метаданные для поиска/публикации |
| `source_url` | страница YouTube/SoundCloud или прямая HTTPS-ссылка |
| `source_job_id`, `candidate_id` | выбор кандидата для `confirm` |
| `enabled` | `true`/`false` для `toggle` |

Workflow использует встроенный `GITHUB_TOKEN` с `permissions: contents: write`. В настройках репозитория должно быть разрешено **Settings → Actions → General → Workflow permissions → Read and write permissions**, иначе commit и Release upload завершатся ошибкой. Пользовательский PAT нужен только аддону, чтобы запускать workflow, читать статусы и отменять запуски. Токен аддона **не передаётся** в inputs workflow.

Задания одного `job_id` не выполняются параллельно. Поиск и публикация разных треков могут идти одновременно.

## Действия worker

### `search`

1. Ищет в YouTube (`ytsearch20`) и SoundCloud (`scsearch15`).
2. Сравнивает название, исполнителя и длительность; отбрасывает слишком далёкие записи.
3. Берёт только метаданные: `pageUrl`, название, автора и длительность.
4. Ничего не скачивает и не создаёт релизов.
5. Записывает `jobs/<job_id>.json` со статусом `ready` и списком кандидатов.

Автоматическая проверка **не определяет цензуру**. Кандидат может быть кавером, ремиксом, концертной записью или повреждённым файлом.

### `confirm`

1. Читает `jobs/<source_job_id>.json`.
2. Проверяет, что кандидат относится к тому же треку и ссылка всё ещё публичная.
3. Скачивает выбранную страницу через yt-dlp и перекодирует в M4A/AAC 160 kbps.
4. Проверяет длительность и загружает файл `<track_id>.m4a` в релиз `library`.
5. Обновляет `list.json` и удаляет прежние версии этого трека.
6. Записывает `jobs/<job_id>.json` со статусом `published`.

### `manual`

1. Принимает только публичный HTTPS URL.
2. Проверяет каждый редирект и запрещает локальные/служебные IP.
3. Ограничивает размер 300 МБ, проверяет content-type.
4. Перекодирует в M4A/AAC и публикует в `library`.
5. Обновляет `list.json`.

URL с временными подписями (`X-Amz-Signature`, `token`, `expires` и т. п.) не подходят: ссылка должна оставаться рабочей.

### `toggle` / `remove`

- `toggle` меняет `enabled` у записи в `list.json`.
- `remove` удаляет запись из `list.json`, но не удаляет аудио из Releases.

## Формат `list.json`

```json
{
  "schema": 1,
  "name": "Uncensor Cloud",
  "updatedAt": "2026-01-01T00:00:00Z",
  "tracks": {
    "12345678": {
      "trackId": "12345678",
      "title": "Название",
      "artists": ["Исполнитель"],
      "durationMs": 245000,
      "enabled": true,
      "audioUrl": "https://github.com/OWNER/REPO/releases/download/library/12345678.m4a",
      "assetName": "12345678.m4a",
      "releaseTag": "library",
      "source": {
        "provider": "youtube",
        "pageUrl": "https://www.youtube.com/watch?v=...",
        "title": "Название",
        "artist": "Исполнитель",
        "uploader": "Канал",
        "durationMs": 245000,
        "score": 0.91,
        "warnings": ["автоматическая проверка не гарантирует отсутствие цензуры"]
      },
      "addedAt": "2026-01-01T00:00:00Z",
      "updatedAt": "2026-01-01T00:00:00Z"
    }
  }
}
```

В `library` остаётся только один файл на трек. Устаревшие preview-файлы и релиз `previews` удаляются автоматически при следующем запуске worker.

## Требования к токену

Fine-grained token:

- **Contents**: Read and write
- **Actions**: Read and write
- **Metadata**: Read

Классический token: `repo` + `workflow`.

Токен нужен для `/actions/workflows/.../dispatches`, отмены запусков, чтения `list.json`/`jobs`, а также при необходимости для закрытых API-запросов. Если сохранять токен не нужно, аддон работает в режиме чтения: библиотека доступна, новые задания не запускаются.

## Ограничения и риски

- GitHub Actions может быть недоступен с IP datacenter для YouTube/SoundCloud. Это внешнее ограничение.
- Публичные release assets могут иметь `Content-Disposition: attachment`; большинство браузерных media-элементов воспроизводит их, но это зависит от WebHost.
- GitHub Contents API не отдаёт inline-содержимое файлов >1 МБ; worker использует `download_url` как fallback.
- `jobs` публичны. Не записывайте туда токены и персональные данные.
- Аддон не проверяет авторские права. Публикация аудио — ответственность владельца репозитория. Безопаснее всего публиковать только записи, права на которые подтверждены.
- Приватный репозиторий несовместим с публичным воспроизведением.

## Локальные проверки

```bash
python3 -m unittest discover -s tests/worker -v
python3 -m py_compile cloud/uncensor_worker.py
```

Для работы worker локально нужны `ffmpeg`, `ffprobe`, `yt-dlp` и `requests`:

```bash
python3 -m pip install -r cloud/requirements.txt
```

## Отладка

- `jobs/<job_id>.json` содержит `status`, `startedAt`, `etaSeconds`, `error.code`, `error.message`, `error.detail`.
- Ссылка `runUrl` ведёт в журнал Actions.
- Если файл статуса не появился, аддон через ~20 секунд ищет запуск по `run-name` и показывает ошибку workflow.
- Ошибки `github_auth` означают нехватку прав токена или отключённые Actions.
