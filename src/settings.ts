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
        pauseOnPreview: {
            type: SettingType.BOOLEAN,
            name: 'Пауза Яндекс Музыки при прослушивании',
            description: 'Останавливает текущее воспроизведение перед запуском предпросмотра кандидата.',
            default: true,
        },
        autoResume: {
            type: SettingType.BOOLEAN,
            name: 'Возобновлять музыку после предпросмотра',
            description: 'Возвращает воспроизведение только если аддон сам поставил его на паузу. По умолчанию выключено.',
            default: false,
        },
    },
    { title: 'stupidCensor' },
)
