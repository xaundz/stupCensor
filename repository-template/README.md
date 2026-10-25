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
   - **Secrets: Read and write** — чтобы аддон мог загрузить cookies и прокси (иначе добавьте их вручную).
   - **Issues: Read and write** — чтобы принимать заявки в аддоне.

Друзьям для чтения общей библиотеки токен не нужен. Для добавления записей друг подключает свой fine-grained token с правами **Actions: Read and write**, **Contents: Read**, **Metadata: Read** — без Contents write, чтобы не обходить проверку. Его трек попадает в Issue с меткой `uncensor-request`.

Кнопка «Принять» в аддоне ставит `uncensor-local`. Локальный помощник на компьютере владельца скачивает аудио, загружает готовый M4A в Releases, обновляет `list.json` и удаляет временные файлы. Помощник лежит в `tools/` и в архиве `stupidcensor-local-helper` из Releases. Для репозитория, отличного от `xaundz/stupidcensor-cloud`, запускайте его так: `STUPIDCENSOR_REPO=владелец/репозиторий ./tools/start-local-publisher.command`. Метка `uncensor-approved` — запасной вариант для публикации через GitHub Actions. `uncensor-rejected` отклоняет заявку. Прямой collaborator с Contents write всё ещё может обойти это ограничение через сайт GitHub, поэтому не выдавайте такой доступ без необходимости.

Подробная инструкция — в `setup-ru.html`.

## Файлы

- `list.json` — публичный индекс подмен. Не добавляйте сюда токены.
- `jobs/<id>.json` — статусы заданий, создаются автоматически.
- `submissions/<id>.json` — данные заявок не-владельцев; удаляются после публикации или отклонения.
- Релиз `library` — аудиофайлы, которые появляются только после подтверждения. На каждый трек хранится один файл; старые версии удаляются автоматически, удаление связи удаляет и файл.

## Важно

- Автоматическая проверка не определяет цензуру. Проверяйте источник перед публикацией.
- Поиск: YouTube и SoundCloud. В ручную ссылку можно вставить страницу YouTube или SoundCloud.
- Для локальной загрузки прокси не нужен: помощник использует домашний IP и cookies выбранного браузера. Если YouTube блокирует и домашний IP, запустите помощник с `--proxy`.
- Запасной путь через GitHub Actions может блокироваться YouTube по IP. Для него добавьте `YTDLP_COOKIES` в формате Netscape или `base64:<...>` и/или `YTDLP_PROXY`. Автоматически читать cookies браузера аддон не умеет. SoundCloud с DRM скачать нельзя; выберите другую запись.
- Аудио публично. Публикуя его, владелец репозитория отвечает за соблюдение авторских прав. Публикуйте только записи, на которые у вас есть права.
- Приватный репозиторий не подходит для воспроизведения по публичным ссылкам.

stupidCensor 1.5.0 · xaunds · PulseSync Addon Development License 1.1.
