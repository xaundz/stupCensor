import type { AddonApi, TrackMenuContext } from '@pulsesync/addon-sdk'

import type { TrackRef } from '../types.ts'
import { extractTrackArray, isYandexTrackId, normalizeTrackMeta, sanitizeText } from './format.ts'

export function trackFromMenu(context: TrackMenuContext): TrackRef {
    return {
        id: String(context.id),
        title: sanitizeText(context.title, 300),
        albumId: context.albumId,
    }
}

export function trackFromCurrent(current: { id?: string; title?: string; artists?: unknown; durationMs?: number; duration?: number } | null): TrackRef | null {
    if (!current?.id) return null
    return normalizeTrackMeta(current, { id: String(current.id), title: '', artist: '', durationMs: undefined })
}

export async function resolveTrack(api: AddonApi, seed: TrackRef): Promise<TrackRef> {
    if (!isYandexTrackId(seed.id)) return seed
    try {
        const payload = await api.resources.read(
            { resource: 'tracks', method: 'getTracksMeta' },
            { trackIds: [seed.id] },
        )
        const items = extractTrackArray(payload)
        const found = items.find(item => {
            if (!item || typeof item !== 'object') return false
            return String((item as Record<string, unknown>).id ?? '') === seed.id
        })
        if (found) return normalizeTrackMeta(found, seed)
    } catch (error) {
        api.logger.warn('Не удалось прочитать метаданные трека, используются данные меню', error)
    }
    try {
        const current = await api.client.getCurrentTrack()
        if (current && String(current.id) === seed.id) {
            return normalizeTrackMeta(current, seed)
        }
    } catch {
        return seed
    }
    return seed
}
