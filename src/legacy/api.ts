import type { AddonApi, AddonLogger, WebHostClient } from '@pulsesync/addon-sdk'
import type {
    AddonSettings,
    AddonSettingsStore,
    PulseSyncApi,
    PulseSyncPageEntity,
    PulseSyncPlayerSnapshot,
    PulseSyncQueueSnapshot,
    PulseSyncResourceReadTarget,
    PulseSyncResourceHooks,
    PulseSyncResourceRequest,
    PulseSyncResourceTarget,
    PulseSyncRouteSnapshot,
    PulseSyncTrackMeta,
} from '@pulsesync/yamusic-types'

import { ADDON_DIRECTORY, ADDON_ID, ADDON_NAME, ADDON_VERSION } from './constants.ts'
import { settings } from './settings.ts'

type LegacyPulseSyncApi = PulseSyncApi & {
    readResource: (
        target: PulseSyncResourceReadTarget,
        request: PulseSyncResourceRequest,
        signal?: AbortSignal,
    ) => Promise<unknown>
    getNativeLyrics?: (trackId: string, format?: 'LRC' | 'TEXT') => Promise<string | null>
    registerResourceHook?: (
        target: PulseSyncResourceTarget,
        hooks: PulseSyncResourceHooks,
        ownerId: string,
    ) => () => void
    _waitForPlayer?: (callback: (player: unknown) => void) => void
}

declare global {
    interface Window {
        pulsesyncApi?: LegacyPulseSyncApi
        __stupidCensorCleanup?: () => void
    }
}

const log: AddonLogger = {
    info: (...args) => console.info('[stupidCensor]', ...args),
    warn: (...args) => console.warn('[stupidCensor]', ...args),
    error: (...args) => console.error('[stupidCensor]', ...args),
}

function abortError(): DOMException {
    return new DOMException('Addon stopped', 'AbortError')
}

function combineSignals(controller: AbortController, external?: AbortSignal | null): () => void {
    if (!external) return () => undefined
    if (external.aborted) {
        controller.abort(external.reason)
        return () => undefined
    }
    const onAbort = () => controller.abort(external.reason)
    external.addEventListener('abort', onAbort, { once: true })
    return () => external.removeEventListener('abort', onAbort)
}

function storageKeys(): string[] {
    const keys: string[] = []
    try {
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index)
            if (key?.startsWith('stupidcensor.') || key?.startsWith('uncensor.')) keys.push(key)
        }
    } catch {
        return []
    }
    return keys
}

export type LegacyContext = {
    api: AddonApi
    pulsesync: LegacyPulseSyncApi
    dispose: () => void
}

export function createLegacyApi(): LegacyContext {
    const pulsesync = window.pulsesyncApi
    if (!pulsesync) throw new Error('PulseSync API is not available')

    const controller = new AbortController()
    const cleanups = new Set<() => void>()
    const timers = new Set<number>()
    let disposed = false

    const onCleanup = (cleanup: () => void): (() => void) => {
        if (disposed) {
            try {
                cleanup()
            } catch (error) {
                log.warn('cleanup failed', error)
            }
            return () => undefined
        }
        cleanups.add(cleanup)
        return () => {
            cleanups.delete(cleanup)
        }
    }

    const dispose = () => {
        if (disposed) return
        disposed = true
        controller.abort(abortError())
        for (const timer of timers) window.clearTimeout(timer)
        timers.clear()
        for (const cleanup of [...cleanups].reverse()) {
            try {
                cleanup()
            } catch (error) {
                log.warn('cleanup failed', error)
            }
        }
        cleanups.clear()
    }

    const setIntervalSafe = (callback: () => void, delayMs: number): (() => void) => {
        if (disposed) return () => undefined
        const id = window.setInterval(() => {
            if (disposed) {
                window.clearInterval(id)
                return
            }
            try {
                callback()
            } catch (error) {
                log.error('interval callback failed', error)
            }
        }, delayMs)
        return onCleanup(() => window.clearInterval(id))
    }

    const setTimeoutSafe = (callback: () => void, delayMs: number): (() => void) => {
        if (disposed) return () => undefined
        const id = window.setTimeout(() => {
            timers.delete(id)
            try {
                callback()
            } catch (error) {
                log.error('timeout callback failed', error)
            }
        }, delayMs)
        timers.add(id)
        return () => {
            timers.delete(id)
            window.clearTimeout(id)
        }
    }

    const listen = (
        target: EventTarget,
        type: string,
        listener: EventListener,
        options?: AddEventListenerOptions,
    ): (() => void) => {
        if (disposed) return () => undefined
        target.addEventListener(type, listener, options)
        return onCleanup(() => target.removeEventListener(type, listener, options))
    }

    const client = pulsesync as unknown as WebHostClient

    const netFetch = async (input: RequestInfo | URL, options: RequestInit & { timeoutMs?: number } = {}) => {
        const { timeoutMs = 15_000, signal, ...init } = options
        const requestController = new AbortController()
        const detach = combineSignals(requestController, signal ?? controller.signal)
        const timer =
            timeoutMs > 0
                ? window.setTimeout(() => {
                      requestController.abort(new DOMException('Request timed out', 'TimeoutError'))
                  }, timeoutMs)
                : undefined
        try {
            return await fetch(input, { ...init, signal: requestController.signal })
        } finally {
            detach()
            if (timer !== undefined) window.clearTimeout(timer)
        }
    }

    const api: AddonApi = {
        addonId: ADDON_ID,
        addon: {
            id: ADDON_ID,
            name: ADDON_NAME,
            directoryName: ADDON_DIRECTORY,
            version: ADDON_VERSION,
        },
        signal: controller.signal,
        onCleanup,
        setInterval: setIntervalSafe,
        setTimeout: setTimeoutSafe,
        listen,
        resources: {
            read: (target, request) => pulsesync.readResource(target, request, controller.signal),
            getLyrics: (trackId, format) =>
                typeof pulsesync.getNativeLyrics === 'function'
                    ? pulsesync.getNativeLyrics(trackId, format)
                    : Promise.resolve(null),
            registerHook: async (target, hooks) => {
                if (typeof pulsesync.registerResourceHook !== 'function') return () => undefined
                const off = pulsesync.registerResourceHook(target, hooks, ADDON_ID)
                return () => {
                    off()
                }
            },
        },
        client,
        pulsesyncApi: client,
        player: {
            getSnapshot: async () => pulsesync.getPlayerSnapshot(),
            onChange: listener => pulsesync.onPlayerSnapshotChange(listener as (snapshot: PulseSyncPlayerSnapshot) => void),
            onQueueChange: listener =>
                pulsesync.onQueueChange(listener as (snapshot: PulseSyncQueueSnapshot) => void),
            onTrackChange: listener =>
                pulsesync.onCurrentTrackChange(listener as (track: PulseSyncTrackMeta | null) => void),
        },
        page: {
            getSnapshot: async () => (await pulsesync.getPageEntity()) as PulseSyncPageEntity,
            onChange: listener => pulsesync.onPageEntityChange(listener as (snapshot: PulseSyncPageEntity) => void),
        },
        router: {
            getSnapshot: async () => pulsesync.getRouteSnapshot() as PulseSyncRouteSnapshot,
            onChange: listener => pulsesync.onRouteChange(listener as (snapshot: PulseSyncRouteSnapshot) => void),
        },
        user: {
            getLogin: () => pulsesync.getUserLogin(),
        },
        notifications: {
            show: (message, options) =>
                pulsesync.showToast(message, options, ADDON_ID).catch(error => log.warn('toast failed', error)),
            info: async (message, options) => {
                try {
                    await pulsesync.showNotification(message, 'info', options, ADDON_ID)
                } catch {
                    await pulsesync.showToast(message, { durationMs: options?.durationMs }, ADDON_ID).catch(() => undefined)
                }
            },
            error: async (message, options) => {
                try {
                    await pulsesync.showNotification(message, 'error', options, ADDON_ID)
                } catch {
                    await pulsesync.showToast(message, { durationMs: options?.durationMs }, ADDON_ID).catch(() => undefined)
                }
            },
        },
        toasts: {
            show: (message, options) =>
                pulsesync.showToast(message, options, ADDON_ID).catch(error => log.warn('toast failed', error)),
        },
        modals: {
            open: async () => false,
            alert: options => pulsesync.showModal('alert', options, ADDON_ID),
            confirm: options => pulsesync.showModal('confirm', options, ADDON_ID),
            form: options => pulsesync.showFormModal(options, ADDON_ID),
        },
        settings: {
            getCurrent: <TSettings extends AddonSettings = AddonSettings>() => settings.store as unknown as TSettings,
            onChange: callback => settings.subscribe(() => callback(settings.store as AddonSettings)),
        } as AddonSettingsStore,
        assets: {
            list: async () => [],
            url: fileName => fileName,
            fetch: (fileName, init) => fetch(fileName, init),
        },
        net: {
            fetch: netFetch,
            json: async <T = unknown>(input: RequestInfo | URL, options?: RequestInit & { timeoutMs?: number }) => {
                const response = await netFetch(input, options)
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                return (await response.json()) as T
            },
            text: async (input, options) => {
                const response = await netFetch(input, options)
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                return await response.text()
            },
        },
        storage: {
            get: async <T = unknown>(key: string) => {
                try {
                    const raw = localStorage.getItem(key)
                    return raw === null ? undefined : (JSON.parse(raw) as T)
                } catch {
                    return undefined
                }
            },
            set: async (key, value) => {
                localStorage.setItem(key, JSON.stringify(value))
            },
            remove: async key => {
                localStorage.removeItem(key)
            },
            keys: async () => storageKeys(),
            clear: async () => {
                for (const key of storageKeys()) localStorage.removeItem(key)
            },
        },
        logger: log,
    }

    return { api, pulsesync, dispose }
}
