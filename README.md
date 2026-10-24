# stupidCensor

Legacy script-аддон PulseSync для Яндекс Музыки: поиск альтернативных записей и облачная подмена цензурированных треков через публичный GitHub-репозиторий пользователя.

Автор:  **Xaunds** · версия **1.2.0**.

## Возможности

- Пункты меню трека: **«Найти без цензуры»** и **«stupidCensor: открыть»**.
- Автопоиск и автосохранение уверенных совпадений; при сомнении — подтверждение в панели.
- Пометка **SC** у треков с активной заменой.
- Поиск через GitHub Actions (`workflow_dispatch`) и yt-dlp: YouTube, SoundCloud, Rutube, Dailymotion.
- Поиск только по метаданным: аудио не скачивается и не публикуется до подтверждения.
- Публикация выбранного файла в GitHub Releases и запись в `list.json`.
- Автоматическая регистрация подмен по ID трека.
- Отмена заданий, ориентировочное время и статусы без ручного обновления.
- Ручное добавление по прямой HTTPS-ссылке или странице YouTube, SoundCloud, Rutube, Dailymotion, Vimeo, Bandcamp, VK.
- Массовый поиск для текущей очереди Яндекс Музыки.
- Общая библиотека для друзей: достаточно публичного репозитория, токен не нужен.
- Права владельца: журнал Actions, удаление из `list.json`/Releases и проверка заявок доступны только владельцу.
- Добавления друзей проходят через GitHub Issues и публикуются только после метки `uncensor-approved`.
- YouTube cookies через секрет `YTDLP_COOKIES`, прокси `YTDLP_PROXY` и встроенная проверка доступа.
- Библиотека, настройки GitHub и режим чтения без токена.

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
   - `.github/workflows/uncensor-approve.yml`;
   - `cloud/uncensor_worker.py`;
   - `cloud/requirements.txt`;
   - пустой `list.json` (пример: `list.example.json`).
3. Включите Actions и оба workflow (**Uncensor Cloud** и **Uncensor Cloud Approval**), затем разрешите **Settings → Actions → General → Workflow permissions → Read and write permissions**.
4. Создайте fine-grained token: **Contents — Read and write**, **Actions — Read and write**, **Metadata — Read**.
5. Откройте меню трека (три точки) → **«stupidCensor: открыть»** → вкладка **«GitHub»**, укажите `владелец/репозиторий` и токен.
6. В меню трека выберите **«Найти без цензуры»**. Уверенное совпадение аддон сохранит сам, иначе откроет панель для подтверждения.

### Общая библиотека для друзей

Друзьям не нужен токен. В разделе **«GitHub»** есть кнопка **«Подключить общую библиотеку»** с репозиторием `xaundz/stupidcensor-cloud`. Они увидят замены владельца и смогут скрывать их только у себя. Для добавления треков другу нужен личный fine-grained token: **Actions — Read and write**, **Contents — Read**, **Metadata — Read**. Его выбор создаёт Issue и публикуется только после подтверждения владельцем; не выдавайте другу `Contents: write`, иначе он сможет обойти проверку через сайт GitHub.

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
  ├─ remove  → list.json + удаление assets трека из Releases
  ├─ check   → проверка доступа YouTube с cookies/прокси
  ├─ friend confirm/manual → submissions/<id>.json + Issue (uncensor-request)
  └─ approval label → approve/reject request

Uncensor Cloud Approval (issues: labeled, только владелец)
  ├─ approved → confirm/manual → публикация
  └─ rejected → удалить submission и закрыть Issue
```

- `jobs/<jobId>.json` — публичный статус задания.
- `submissions/<jobId>.json` — данные заявки друга; удаляется после публикации или отклонения.
- `list.json` — индекс замен, читается аддоном.
- Релиз `library` — постоянные аудиофайлы для подмен.
- При удалении связи владельцем удаляются и запись индекса, и аудиофайлы трека. Обычный пользователь может только скрыть замену у себя.

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
- `.github/workflows/uncensor-cloud.yml` — основной workflow.
- `.github/workflows/uncensor-approve.yml` — approval workflow для заявок друзей.
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
- yt-dlp с IP GitHub Actions может получать отказы YouTube/SoundCloud. Для YouTube можно добавить секрет `YTDLP_COOKIES` (Netscape cookies).
- SoundCloud-треки с DRM скачать нельзя: аддон помечает их как недоступные и предлагает другой источник.
- Аддон не обходит авторизацию, DRM или платный доступ.
- Collaborator с правом `Contents: write` технически может удалить файл или обойти approval через сайт GitHub. Запрет удаления и проверка заявок действуют в аддоне и worker, но не заменяют настройки доступа GitHub. Не выдавайте друзьям `Contents: write`.
- Публикуя аудио, пользователь отвечает за соблюдение авторских прав и правил GitHub. Безопаснее публиковать только записи, права на которые подтверждены.
- В `library` хранится один аудиофайл на трек. При замене старые версии трека удаляются автоматически; при удалении связи удаляется и его файл.

## Лицензия

Исходный шаблон распространяется по **PulseSync Addon Development License 1.1**: [русский текст](./LICENSE.ru.md) · [English](./LICENSE). При расхождениях применяется русская версия в пределах, допускаемых законом.

Copyright © 2026 xaunds. Все права защищены.
