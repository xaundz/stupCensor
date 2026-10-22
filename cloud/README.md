# Uncensor Cloud: облачная часть

Эта папка и `.github/workflows/uncensor-cloud.yml` размещаются в **публичном** GitHub-репозитории пользователя. Аддон не хранит аудио у себя: он запускает workflow и читает публичный индекс.

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

Workflow использует встроенный `GITHUB_TOKEN` с `permissions: contents: write`. В настройках репозитория должно быть разрешено **Settings → Actions → General → Workflow permissions → Read and write permissions**, иначе commit и Release upload завершатся ошибкой. Пользовательский PAT нужен только аддону, чтобы запускать workflow и читать статусы. Токен аддона **не передаётся** в inputs workflow.

## Действия worker

### `search`

1. Ищет в YouTube (`ytsearch20`) и SoundCloud (`scsearch15`).
2. Сравнивает название, исполнителя и длительность; отбрасывает слишком далёкие записи.
3. Скачивает до 5 подходящих кандидатов через yt-dlp.
4. Перекодирует в M4A/AAC 160 kbps через ffmpeg.
5. Загружает превью в релиз `previews`.
6. Записывает `jobs/<job_id>.json` со статусом `ready` и списком кандидатов.

Автоматическая проверка **не определяет цензуру**. Кандидат может быть кавером, ремиксом, концертной записью или повреждённым файлом; поэтому UI требует прослушать запись.

### `confirm`

1. Читает `jobs/<source_job_id>.json`.
2. Проверяет, что кандидат относится к тому же треку и ещё доступен.
3. Скачивает preview из релиза `previews` по API и сверяет SHA-256.
4. Загружает тот же файл в релиз `library`.
5. Обновляет `list.json`, сохраняя историю старой замены.
6. Записывает `jobs/<job_id>.json` со статусом `published`.

SHA-256 важен: в библиотеку попадает именно тот файл, который пользователь прослушал.

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
      "audioUrl": "https://github.com/OWNER/REPO/releases/download/library/12345678-cand-abc123.m4a",
      "assetName": "12345678-cand-abc123.m4a",
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

`history` хранит до 20 предыдущих ссылок. UI показывает последние 10.

## Требования к токену

Fine-grained token:

- **Contents**: Read and write
- **Actions**: Read and write
- **Metadata**: Read

Классический token: `repo` + `workflow`.

Токен нужен для `/actions/workflows/.../dispatches`, чтения `list.json`/`jobs`, а также при необходимости для закрытых API-запросов. Если сохранять токен не нужно, аддон работает в режиме чтения: библиотека и предпросмотры доступны, новые задания не запускаются.

## Ограничения и риски

- GitHub Actions может быть недоступен с IP datacenter для YouTube/SoundCloud. Это внешнее ограничение.
- Публичные release assets могут иметь `Content-Disposition: attachment`; большинство браузерных media-элементов воспроизводит их, но это зависит от WebHost.
- GitHub Contents API не отдаёт inline-содержимое файлов >1 МБ; worker использует `download_url` как fallback.
- Один релиз `previews` накапливает assets. При большом количестве заданий удаляйте старые assets вручную или добавляйте cleanup workflow.
- `jobs` и preview-файлы публичны. Не записывайте туда токены и персональные данные.
- Аддон не проверяет авторские права. Публикация аудио — ответственность владельца репозитория.
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

- `jobs/<job_id>.json` содержит `status`, `error.code`, `error.message`, `error.detail`.
- Ссылка `runUrl` ведёт в журнал Actions.
- Если файл статуса не появился, аддон через ~20 секунд ищет запуск по `run-name` и показывает ошибку workflow.
- Ошибки `github_auth` означают нехватку прав токена или отключённые Actions.
