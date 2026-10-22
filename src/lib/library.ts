import type { AddonApi } from '@pulsesync/addon-sdk'

import { REPLACEMENT_OWNER } from '../legacy/constants.ts'
import type { LibraryIndex, TrackMapping, TrackRef } from '../types.ts'
import { isYandexTrackId, isStableHttpsUrl, normalizeArtistList, sanitizeText } from './format.ts'

export const EMPTY_INDEX: LibraryIndex = {
    schema: 1,
    name: 'stupidCensor library',
    updatedAt: new Date(0).toISOString(),
    tracks: {},
}

function normalizeSource(raw: unknown): TrackMapping['source'] {
    const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const providerRaw = sanitizeText(source.provider, 24)
    const provider = providerRaw === 'youtube' || providerRaw === 'soundcloud' || providerRaw === 'manual'
        ? providerRaw
        : 'unknown'
    return {
        provider,
        pageUrl: sanitizeText(source.pageUrl, 1000),
        title: sanitizeText(source.title, 400),
        artist: sanitizeText(source.artist, 400),
        uploader: sanitizeText(source.uploader, 300),
        durationMs: Math.max(0, Number(source.durationMs) || 0),
        score: typeof source.score === 'number' ? source.score : undefined,
        warnings: Array.isArray(source.warnings)
            ? source.warnings.map(item => sanitizeText(item, 120)).filter(Boolean).slice(0, 20)
            : undefined,
        manual: source.manual === true,
    }
}

export function normalizeMapping(raw: unknown, trackId: string): TrackMapping | null {
    if (!raw || typeof raw !== 'object') return null
    const data = raw as Record<string, unknown>
    const id = sanitizeText(data.trackId, 32) || trackId
    if (!isYandexTrackId(id)) return null
    const audioUrl = sanitizeText(data.audioUrl, 2000)
    if (!isStableHttpsUrl(audioUrl)) return null
    const artists = normalizeArtistList(data.artists)
    return {
        trackId: id,
        title: sanitizeText(data.title, 400) || `Трек ${id}`,
        artists,
        durationMs: Math.max(0, Number(data.durationMs) || 0),
        enabled: data.enabled !== false,
        audioUrl,
        assetName: sanitizeText(data.assetName, 300),
        releaseTag: sanitizeText(data.releaseTag, 120) || 'library',
        source: normalizeSource(data.source),
        addedAt: sanitizeText(data.addedAt, 40) || new Date(0).toISOString(),
        updatedAt: sanitizeText(data.updatedAt, 40) || new Date(0).toISOString(),
    }
}

export function parseIndex(raw: unknown): LibraryIndex {
    if (!raw || typeof raw !== 'object') {
        throw new Error('list.json: ожидается объект.')
    }
    const data = raw as Record<string, unknown>
    if (data.tracks === undefined) {
        throw new Error('list.json: отсутствует поле tracks.')
    }
    if (!data.tracks || typeof data.tracks !== 'object' || Array.isArray(data.tracks)) {
        throw new Error('list.json: поле tracks должно быть объектом.')
    }
    const tracks: Record<string, TrackMapping> = {}
    for (const [trackId, value] of Object.entries(data.tracks as Record<string, unknown>)) {
        const mapping = normalizeMapping(value, trackId)
        if (mapping) tracks[mapping.trackId] = mapping
    }
    return {
        schema: Number(data.schema) || 1,
        name: sanitizeText(data.name, 200) || 'stupidCensor library',
        updatedAt: sanitizeText(data.updatedAt, 40),
        tracks,
    }
}

export function isMappingUsable(mapping: TrackMapping, disabled: ReadonlySet<string>, removed: ReadonlySet<string>): boolean {
    return mapping.enabled && !disabled.has(mapping.trackId) && !removed.has(mapping.trackId)
}

export function enabledReplacements(
    index: LibraryIndex,
    disabled: ReadonlySet<string>,
    removed: ReadonlySet<string>,
): Record<string, string> {
    const result: Record<string, string> = {}
    for (const mapping of Object.values(index.tracks)) {
        if (!isMappingUsable(mapping, disabled, removed)) continue
        if (!isYandexTrackId(mapping.trackId)) continue
        if (!isStableHttpsUrl(mapping.audioUrl)) continue
        result[mapping.trackId] = mapping.audioUrl
    }
    return result
}

export async function applyLibrary(
    api: AddonApi,
    index: LibraryIndex,
    disabled: ReadonlySet<string>,
    removed: ReadonlySet<string>,
): Promise<number> {
    const replacements = enabledReplacements(index, disabled, removed)
    await api.client.clearTrackReplacements(REPLACEMENT_OWNER)
    const count = Object.keys(replacements).length
    if (!count) return 0
    await api.client.setTrackReplacements(replacements, REPLACEMENT_OWNER)
    return count
}

export async function applyOne(api: AddonApi, mapping: TrackMapping): Promise<boolean> {
    if (!isYandexTrackId(mapping.trackId) || !isStableHttpsUrl(mapping.audioUrl)) return false
    return api.client.setTrackReplacement(mapping.trackId, mapping.audioUrl, REPLACEMENT_OWNER)
}

export async function disableOne(api: AddonApi, trackId: string): Promise<boolean> {
    if (!isYandexTrackId(trackId)) return false
    return api.client.removeTrackReplacement(trackId, REPLACEMENT_OWNER)
}

export async function clearOwnReplacements(api: AddonApi): Promise<void> {
    try {
        await api.client.clearTrackReplacements(REPLACEMENT_OWNER)
    } catch (error) {
        api.logger.warn('Не удалось очистить регистрации подмен', error)
    }
}

export async function reloadCurrentTrack(api: AddonApi, trackId: string): Promise<'reloaded' | 'not-current' | 'restart-required'> {
    if (!isYandexTrackId(trackId)) return 'restart-required'
    const current = await api.client.getCurrentTrack()
    if (!current || String(current.id) !== trackId) return 'not-current'
    try {
        const reloaded = await api.client.reloadPlayer(trackId)
        return reloaded ? 'reloaded' : 'restart-required'
    } catch (error) {
        api.logger.warn('reloadPlayer не сработал', error)
        return 'restart-required'
    }
}

export function findMappingForTrack(index: LibraryIndex | null, track: TrackRef | null): TrackMapping | null {
    if (!index || !track) return null
    return index.tracks[track.id] ?? null
}

export function mappingCount(index: LibraryIndex | null): number {
    return index ? Object.keys(index.tracks).length : 0
}
