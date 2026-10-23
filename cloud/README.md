# Uncensor Cloud: облачная часть

Эта папка и workflows `.github/workflows/uncensor-cloud.yml` + `.github/workflows/uncensor-approve.yml` размещаются в **публичном** GitHub-репозитории пользователя. Аддон не хранит аудио у себя: он запускает workflow, читает публичный индекс и скачивает аудио только для выбранной записи. Добавления друзей проходят через Issues и подтверждение владельцем.

## Состав репозитория

```text
list.json
.github/workflows/uncensor-cloud.yml
.github/workflows/uncensor-approve.yml
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

## Workflows

### Uncensor Cloud

Запускается через `workflow_dispatch` с входными параметрами:

| Параметр | Назначение |
| --- | --- |
| `action` | `search`, `confirm`, `manual`, `toggle`, `remove` (без `reject`) |
| `job_id` | UUID задания, создаётся аддоном |
| `track_id` | ID трека Яндекс Музыки |
| `artist`, `title`, `duration` | метаданные для поиска/публикации |
| `source_url` | страница YouTube/SoundCloud или прямая HTTPS-ссылка |
| `source_job_id`, `candidate_id` | выбор кандидата для `confirm` |
| `enabled` | `true`/`false` для `toggle` |

Workflow использует встроенный `GITHUB_TOKEN` с `permissions: contents: write` и `issues: write`. В настройках репозитория должно быть разрешено **Settings → Actions → General → Workflow permissions → Read and write permissions**, иначе commit, Release upload и создание заявок завершатся ошибкой. Пользовательский PAT нужен только аддону, чтобы запускать workflow, читать статусы и отменять запуски. Токен аддона **не передаётся** в inputs workflow.

### Uncensor Cloud Approval

Запускается событием `issues: labeled` для меток `uncensor-approved` и `uncensor-rejected`. Workflow проверяет, что метку поставил владелец репозитория, находит `submissions/<job_id>.json` по номеру Issue и запускает worker:

- `uncensor-approved` — worker скачивает запись и публикует её, затем удаляет submission, ставит `uncensor-published`, комментирует и закрывает Issue;
- `uncensor-rejected` — worker удаляет submission, ставит `uncensor-rejected`, комментирует и закрывает Issue без публикации.

Approval workflow должен находиться в ветке по умолчанию. Метки создаются автоматически при первой заявке.

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
3. Если действие запустил не владелец, создаёт Issue с меткой `uncensor-request` и `submissions/<job_id>.json`, пишет статус `awaiting_approval` и останавливается.
4. Владелец скачивает выбранную страницу через yt-dlp и перекодирует в M4A/AAC 160 kbps.
5. Проверяет длительность и загружает файл `<track_id>.m4a` в релиз `library`.
6. Обновляет `list.json` и удаляет прежние версии этого трека.
7. Записывает `jobs/<job_id>.json` со статусом `published`.

### `manual`

1. Принимает только публичный HTTPS URL.
2. Проверяет каждый редирект и запрещает локальные/служебные IP.
3. Если действие запустил не владелец, создаёт заявку и останавливается до подтверждения.
4. Ограничивает размер 300 МБ, проверяет content-type.
5. Перекодирует в M4A/AAC и публикует в `library`.
6. Обновляет `list.json`.

URL с временными подписями (`X-Amz-Signature`, `token`, `expires` и т. п.) не подходят: ссылка должна оставаться рабочей.

### `toggle` / `remove`

- `toggle` меняет `enabled` у записи в `list.json`.
- `remove` удаляет запись из `list.json` и аудиофайлы трека из Releases.
- `toggle` и `remove` доступны только владельцу; friend-запросы для них отклоняются.

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

Владелец, fine-grained token:

- **Contents**: Read and write
- **Actions**: Read and write
- **Metadata**: Read

Классический token: `repo` + `workflow`.

Друг для добавления записей:

- **Actions**: Read and write
- **Contents**: Read
- **Metadata**: Read

Не выдавайте другу `Contents: write`: collaborator сможет обойти approval через сайт GitHub. Issues приложению не нужен — Issue создаёт workflow встроенным `GITHUB_TOKEN`.

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

- `jobs/<job_id>.json` содержит `status`, `startedAt`, `etaSeconds`, `error.code`, `error.message`, `error.detail`, а для заявок — `issueUrl`, `issueNumber`, `requestedBy`.
- `submissions/<job_id>.json` хранит данные заявки; файл удаляется после approve/reject.
- Ссылка `runUrl` ведёт в журнал Actions.
- Если файл статуса не появился, аддон через ~20 секунд ищет запуск по `run-name` и показывает ошибку workflow.
- Ошибки `github_auth` означают нехватку прав токена или отключённые Actions.
