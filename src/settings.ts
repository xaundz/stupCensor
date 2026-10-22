import { defineAddonSettings, SettingType } from '@pulsesync/addon-sdk'

export const settings = defineAddonSettings(
    {
        enabled: {
            type: SettingType.BOOLEAN,
            name: 'Показывать меню stupidCensor',
            description: 'Добавляет «Найти без цензуры» и «stupidCensor: открыть» в меню трека.',
            default: true,
        },
        autoApply: {
            type: SettingType.BOOLEAN,
            name: 'Автоматически применять библиотеку',
            description: 'Регистрирует включённые подмены при запуске и обновлении библиотеки.',
            default: true,
        },
    },
    { title: 'stupidCensor' },
)
