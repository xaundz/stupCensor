## stupidCensor 1.5.0

Локальная загрузка без GitHub Actions: владелец нажимает «Принять» в панели, помощник на его компьютере скачивает аудио, публикует M4A в Releases и удаляет временные файлы. Друзьям по-прежнему не нужен YouTube и токен: они получают готовую замену из общей библиотеки.

### Установка аддона

1. Скачайте `stupidCensor-1.5.0.pext`.
2. Установите его как обычный `.pext` в PulseSync.
3. Откройте настройки stupidCensor и проверьте GitHub-репозиторий библиотеки.

### Локальный помощник владельца

1. Скачайте `stupidcensor-local-helper-1.5.0.zip` и распакуйте.
2. Установите Python 3.11+ и ffmpeg: `brew install ffmpeg`.
3. Запустите `install-token.command` и вставьте fine-grained token владельца с правами **Contents: Read and write** и **Issues: Read and write**.
4. Запустите `start-local-publisher.command`. Terminal должен оставаться открытым.

По умолчанию cookies YouTube читаются из Chrome. Для Firefox: `STUPIDCENSOR_BROWSER=firefox ./start-local-publisher.command`. Cookies не отправляются в GitHub. Прокси опционален.

Кнопка «Принять» ставит `uncensor-local`; помощник забирает заявку. Если помощник выключен, заявка ждёт. При ошибке причина появится в Issue, метка снимется, заявку можно повторить. `uncensor-approved` остаётся запасным вариантом для GitHub Actions.

### Файлы

- `stupidCensor-1.5.0.pext` — аддон.
- `stupidcensor-local-helper-1.5.0.zip` — локальный помощник.
- `stupidcensor-repository-1.5.0.zip` — шаблон облачного репозитория.
- `stupidCensor-1.5.0-source.zip` — исходники.
- `SHA256SUMS-1.5.0.txt` — контрольные суммы.

### Важно

- Для кнопки «Принять» токену нужен `Issues: Read and write`.
- `Secrets: Read and write` нужен только для сохранения cookies/proxy из панели.
- YouTube всё ещё может потребовать вход; помощник использует cookies вашего браузера.
