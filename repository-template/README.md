# Uncensor Cloud — облачный репозиторий

Здесь работают GitHub Actions workflows **Uncensor Cloud** и **Uncensor Cloud Approval**. Аддон PulseSync запускает поиск и заявки через `workflow_dispatch`; владелец проверяет заявки в Issues и публикует аудио в Releases только после подтверждения.

Перед первым запуском:

1. Оставьте репозиторий **публичным**.
2. Включите **Actions** и оба workflow: **Uncensor Cloud** и **Uncensor Cloud Approval**.
3. В **Settings → Actions → General → Workflow permissions** выберите **Read and write permissions**. Approval workflow сам запрашивает `contents: write` и `issues: write`.
4. Не меняйте пути `.github/workflows/uncensor-cloud.yml`, `.github/workflows/uncensor-approve.yml` и `cloud/uncensor_worker.py`. Approval workflow должен быть в ветке по умолчанию.
5. В аддоне укажите `владелец/репозиторий` и fine-grained token с правами:
   - **Contents: Read and write**
   - **Actions: Read and write**
   - **Metadata: Read**

Друзьям для чтения общей библиотеки токен не нужен. Для добавления записей друг подключает свой fine-grained token с правами **Actions: Read and write**, **Contents: Read**, **Metadata: Read** — без Contents write, чтобы не обходить проверку. Его трек попадает в Issue с меткой `uncensor-request`; владелец ставит `uncensor-approved` или `uncensor-rejected`. Только после `uncensor-approved` worker скачивает аудио и обновляет `list.json`. Метки создаются автоматически при первой заявке. Прямой collaborator с Contents write всё ещё может обойти это ограничение через сайт GitHub, поэтому не выдавайте такой доступ без необходимости.

Подробная инструкция — в `setup-ru.html`.

## Файлы

- `list.json` — публичный индекс подмен. Не добавляйте сюда токены.
- `jobs/<id>.json` — статусы заданий, создаются автоматически.
- `submissions/<id>.json` — данные заявок не-владельцев; удаляются после публикации или отклонения.
- Релиз `library` — аудиофайлы, которые появляются только после подтверждения. На каждый трек хранится один файл; старые версии удаляются автоматически, удаление связи удаляет и файл.

## Важно

- Автоматическая проверка не определяет цензуру. Проверяйте источник перед публикацией.
- Поиск: YouTube, SoundCloud, Rutube и Dailymotion. В ручную ссылку можно вставить страницу YouTube, SoundCloud, Rutube, Dailymotion, Vimeo, Bandcamp или VK.
- YouTube может блокировать IP GitHub Actions. Добавьте секрет `YTDLP_COOKIES` с cookies в формате Netscape или `base64:<...>`; при блокировке по IP — `YTDLP_PROXY`. Проверка доступа есть в настройках аддона. SoundCloud с DRM скачать нельзя; worker пробует резервный источник.
- Аудио публично. Публикуя его, владелец репозитория отвечает за соблюдение авторских прав. Публикуйте только записи, на которые у вас есть права.
- Приватный репозиторий не подходит для воспроизведения по публичным ссылкам.

stupidCensor 1.1.4 · xaunds · PulseSync Addon Development License 1.1.
