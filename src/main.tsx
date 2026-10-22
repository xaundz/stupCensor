import { defineAddon, logger, openModal } from '@pulsesync/addon-sdk'
import type { TrackMenuContext } from '@pulsesync/addon-sdk'
import addonConfig from '../addon.config.mjs'
import { Panel } from './components/Panel.tsx'
import { settings } from './settings.ts'
import { initialize, replaceableTrackFromJob, setLastError, startAutoReplace } from './store.ts'
import type { TrackRef } from './types.ts'
import './styles.css'

function isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
}

function trackFromMenu(context: TrackMenuContext): TrackRef {
    return {
        id: String(context.id),
        title: context.title || '',
        albumId: context.albumId,
    }
}

function openStupidCensor(options: { track?: TrackRef | null; initialAction?: 'search' | 'manual' } = {}): Promise<boolean> {
    return openModal(props => (
        <Panel
            {...props}
            initialTrack={options.track ?? null}
            initialAction={options.initialAction}
        />
    ))
}

async function runAutoSearch(track: TrackRef) {
    try {
        const job = await startAutoReplace(track)
        if (job?.status === 'ready') {
            await openStupidCensor({ track: replaceableTrackFromJob(job), initialAction: 'search' })
        }
    } catch (error) {
        logger.error('Не удалось запустить автопоиск', error)
        try {
            await openStupidCensor({ track, initialAction: 'search' })
        } catch (openError) {
            if (!isAbort(openError)) logger.error('Не удалось открыть stupidCensor', openError)
        }
    }
}

export default defineAddon({
    id: addonConfig.id,
    name: addonConfig.name,
    settings,
    start(api) {
        void initialize(api).catch(error => {
            api.logger.error('stupidCensor: ошибка инициализации', error)
            setLastError(error instanceof Error ? error.message : String(error))
            void api.notifications.error('stupidCensor не смог инициализироваться. Откройте настройки аддона.').catch(() => undefined)
        })
    },
    trackMenuItems: [
        {
            id: 'stupid-censor-auto',
            label: 'Найти без цензуры',
            icon: 'explicit',
            position: 'end',
            onClick: async ({ track }) => {
                await runAutoSearch(trackFromMenu(track))
            },
        },
        {
            id: 'stupid-censor-panel',
            label: 'stupidCensor: открыть',
            icon: 'link',
            position: 'end',
            onClick: async ({ track }) => {
                try {
                    await openStupidCensor({ track: trackFromMenu(track) })
                } catch (error) {
                    if (!isAbort(error)) {
                        logger.error('Не удалось открыть панель stupidCensor', error)
                    }
                }
            },
        },
    ],
})
