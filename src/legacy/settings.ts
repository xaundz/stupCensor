import { useSyncExternalStore } from 'react'

import { SETTINGS_KEY } from './constants.ts'

export type AddonSettingsState = {
    enabled: boolean
    autoApply: boolean
    pauseOnPreview: boolean
    autoResume: boolean
}

const defaults: AddonSettingsState = {
    enabled: true,
    autoApply: true,
    pauseOnPreview: true,
    autoResume: false,
}

const listeners = new Set<() => void>()
let state: AddonSettingsState = load()

function asBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback
}

function load(): AddonSettingsState {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY)
        if (!raw) return defaults
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return defaults
        const value = parsed as Record<string, unknown>
        return {
            enabled: asBoolean(value.enabled, defaults.enabled),
            autoApply: asBoolean(value.autoApply, defaults.autoApply),
            pauseOnPreview: asBoolean(value.pauseOnPreview, defaults.pauseOnPreview),
            autoResume: asBoolean(value.autoResume, defaults.autoResume),
        }
    } catch {
        return defaults
    }
}

function persist(next: AddonSettingsState): void {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
    } catch {
        // Storage can be unavailable in private windows; keep in-memory settings.
    }
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

function emit(): void {
    for (const listener of listeners) listener()
}

export const settings = {
    get store(): AddonSettingsState {
        return state
    },
    get(): AddonSettingsState {
        return state
    },
    set(patch: Partial<AddonSettingsState>): void {
        state = { ...state, ...patch }
        persist(state)
        emit()
    },
    reset(): void {
        state = defaults
        persist(state)
        emit()
    },
    subscribe,
    use(): AddonSettingsState {
        return useSyncExternalStore(subscribe, () => state, () => state)
    },
}

export type SettingsStore = typeof settings
