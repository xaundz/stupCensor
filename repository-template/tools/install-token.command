#!/bin/zsh
set -euo pipefail

printf "GitHub token владельца (ввод не отображается): "
read -rs TOKEN
printf "\n"
if [[ -z "${TOKEN}" ]]; then
    print "Токен не введён."
    exit 1
fi
security add-generic-password -U -a "${USER}" -s stupidcensor-local-token -w "${TOKEN}"
unset TOKEN
print "Токен сохранён в Keychain. Его не нужно вводить при каждом запуске."
