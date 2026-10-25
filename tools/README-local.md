# Локальная загрузка stupidCensor

Помощник скачивает одобренные заявки на вашем Mac, загружает готовый M4A в GitHub Releases и удаляет временные файлы. Друзьям не нужно скачивать YouTube: они получают готовую замену из GitHub.

## Установка

1. Установите ffmpeg: `brew install ffmpeg`.
2. Дважды щёлкните `install-token.command` и вставьте fine-grained token владельца. Нужны права **Contents: Read and write** и **Issues: Read and write**.
3. Дважды щёлкните `start-local-publisher.command` и оставьте Terminal открытым.

Первый запуск создаёт `.venv` и устанавливает `yt-dlp` и `requests`. Cookies берутся из Chrome. Для Firefox запустите:

```bash
STUPIDCENSOR_BROWSER=firefox ./start-local-publisher.command
```

## Как это работает

1. Друг выбирает запись в аддоне и отправляет заявку.
2. Вы нажимаете **«Принять»** в панели stupidCensor. Аддон ставит метку `uncensor-local`.
3. Помощник замечает заявку, скачивает аудио на этом компьютере, перекодирует в M4A, загружает в GitHub Releases и обновляет `list.json`.
4. Временные файлы удаляются. Заявка закрывается, друг видит готовую замену.

Если скачивание не удалось, помощник пишет причину в Issue, снимает `uncensor-local` и оставляет заявку открытой. После исправления нажмите **«Принять»** снова.

## Cookies и прокси

YouTube может требовать вход даже с домашнего IP. Помощник умеет читать cookies прямо из браузера, без экспорта в GitHub. По умолчанию используется Chrome, профиль по умолчанию. Другой профиль:

```bash
./start-local-publisher.command --cookies-from-browser "chrome:Profile 1"
```

Если YouTube блокирует и ваш IP, укажите прокси:

```bash
./start-local-publisher.command --proxy "socks5h://user:pass@host:1080"
```

## Проверка и запуск вручную

```bash
./start-local-publisher.command --once --dry-run
./start-local-publisher.command --once
```

Токен можно задать через `GITHUB_TOKEN` вместо Keychain. Не храните токен в файлах репозитория.
