# Uncensor Cloud — облачный репозиторий

Здесь работает GitHub Actions workflow **Uncensor Cloud**. Аддон PulseSync запускает его через `workflow_dispatch`, ищет записи и публикует аудио в Releases только после подтверждения.

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
- Релиз `library` — аудиофайлы, которые появляются только после подтверждения. На каждый трек хранится один файл; старые версии удаляются автоматически.

## Важно

- Автоматическая проверка не определяет цензуру. Проверяйте источник перед публикацией.
- YouTube/SoundCloud могут блокировать IP GitHub Actions.
- Аудио публично. Публикуя его, владелец репозитория отвечает за соблюдение авторских прав. Публикуйте только записи, на которые у вас есть права.
- Приватный репозиторий не подходит для воспроизведения по публичным ссылкам.

stupidCensor 1.1.1 · xaunds · PulseSync Addon Development License 1.1.
