# Uncensor Cloud — облачный репозиторий

Здесь работает GitHub Actions workflow **Uncensor Cloud**. Аддон PulseSync запускает его через `workflow_dispatch`, публикует аудио в Releases и обновляет `list.json`.

Перед первым запуском:

1. Оставьте репозиторий **публичным**.
2. Включите **Actions** и workflow **Uncensor Cloud**.
3. В **Settings → Actions → General → Workflow permissions** выберите **Read and write permissions**.
4. Не меняйте путь `.github/workflows/uncensor-cloud.yml` и `cloud/uncensor_worker.py`.
5. В аддоне укажите `владелец/репозиторий` и fine-grained token с правами:
   - **Contents: Read and write**
   - **Actions: Read and write**
   - **Metadata: Read**

Подробная инструкция — в `setup-ru.html`.

## Файлы

- `list.json` — публичный индекс подмен. Не добавляйте сюда токены.
- `jobs/<id>.json` — статусы заданий, создаются автоматически.
- Релиз `previews` — временные файлы для прослушивания.
- Релиз `library` — постоянные аудиофайлы.

## Важно

- Автоматическая проверка не определяет цензуру. Слушайте кандидатов вручную.
- YouTube/SoundCloud могут блокировать IP GitHub Actions.
- Аудио публично. Публикуя его, владелец репозитория отвечает за соблюдение авторских прав.
- Приватный репозиторий не подходит для воспроизведения по публичным ссылкам.

stupidCensor 1.1.0 · Кирилл (Xaund) · PulseSync Addon Development License 1.1.
