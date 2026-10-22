import type { JobRecord, LibraryIndex, TrackMapping, TrackRef, TrackSearchMeta } from '../types.ts'

export function formatDuration(durationMs: number | undefined): string {
    if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return '—'
    const total = Math.round(durationMs / 1000)
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function formatDurationLong(durationMs: number | undefined): string {
    if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return 'длительность неизвестна'
    const total = Math.round(durationMs / 1000)
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    if (!minutes) return `${seconds} с`
    return `${minutes} мин ${seconds} с`
}

export function formatDate(value: string | number | undefined): string {
    if (!value) return '—'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '—'
    return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date)
}

export function formatDateTime(value: string | number | undefined): string {
    if (!value) return '—'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '—'
    return new Intl.DateTimeFormat('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date)
}

export function pluralRu(count: number, one: string, few: string, many: string): string {
    const mod10 = count % 10
    const mod100 = count % 100
    if (mod10 === 1 && mod100 !== 11) return one
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
    return many
}

export function sanitizeText(value: unknown, maxLength = 400): string {
    if (typeof value !== 'string') return ''
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength)
}

export function normalizeRepoInput(value: string): string {
    const cleaned = value
        .trim()
        .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
        .replace(/\.git$/i, '')
        .replace(/\/+$/, '')
    const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})[A-Za-z0-9]|[A-Za-z0-9])\/([A-Za-z0-9._-]{1,100})$/.exec(cleaned)
    if (!match) return ''
    if (match[1].startsWith('.') || match[1].endsWith('.')) return ''
    if (match[2] === '.' || match[2] === '..') return ''
    return `${match[1]}/${match[2]}`
}

export function isYandexTrackId(value: string | number | undefined): boolean {
    return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)
}

export function isHttpUrl(value: string): boolean {
    try {
        const url = new URL(value)
        return url.protocol === 'https:' || url.protocol === 'http:'
    } catch {
        return false
    }
}

export function isStableHttpsUrl(value: string): boolean {
    try {
        const url = new URL(value)
        if (url.protocol !== 'https:') return false
        return !/(?:^|&)(?:x-amz-signature|x-amz-credential|x-goog-signature|x-goog-credential|sig|signature|token|expires|se|spr)=/i.test(
            url.search.replace(/^\?/, ''),
        )
    } catch {
        return false
    }
}

export function isDirectAudioUrl(value: string): boolean {
    try {
        const url = new URL(value)
        if (!/^https?:$/.test(url.protocol)) return false
        if (/(youtube\.com|youtu\.be|soundcloud\.com|music\.yandex\.)/i.test(url.hostname)) return false
        return /\.(m4a|mp3|aac|ogg|opus|flac|wav|webm|mp4)(?:$|[?#])/i.test(url.pathname + url.search)
    } catch {
        return false
    }
}

export function hostOf(value: string): string {
    try {
        return new URL(value).hostname
    } catch {
        return ''
    }
}

export function providerLabel(provider: string | undefined): string {
    switch (provider) {
        case 'youtube':
            return 'YouTube'
        case 'soundcloud':
            return 'SoundCloud'
        case 'manual':
            return 'Своя ссылка'
        default:
            return 'Источник'
    }
}

export function statusLabel(status: string | undefined): string {
    switch (status) {
        case 'queued':
            return 'В очереди'
        case 'running':
            return 'Выполняется'
        case 'ready':
            return 'Кандидаты готовы'
        case 'published':
            return 'Опубликовано'
        case 'failed':
            return 'Ошибка'
        case 'updated':
            return 'Обновлено'
        case 'removed':
            return 'Связь удалена'
        case 'abandoned':
            return 'Отменено'
        default:
            return 'Неизвестно'
    }
}

export function scorePercent(score: number | undefined): string {
    if (typeof score !== 'number' || !Number.isFinite(score)) return '—'
    return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`
}

const JOB_ETA_SECONDS: Record<JobRecord['action'], number> = {
    search: 40,
    confirm: 75,
    manual: 55,
    toggle: 6,
    remove: 6,
}

export type JobTiming = {
    elapsedSec: number
    remainingSec: number
    progress: number
    label: string
}

export function jobTiming(job: JobRecord, now = Date.now()): JobTiming {
    if (job.status !== 'queued' && job.status !== 'running') {
        return { elapsedSec: 0, remainingSec: 0, progress: 1, label: '' }
    }
    const estimate = Math.max(5, job.etaSeconds || JOB_ETA_SECONDS[job.action] || 30)
    if (job.status === 'queued' || !job.startedAt) {
        return { elapsedSec: 0, remainingSec: estimate, progress: 0.04, label: 'ждём runner' }
    }
    const started = new Date(job.startedAt).getTime()
    const elapsedSec = Number.isFinite(started) ? Math.max(0, Math.round((now - started) / 1000)) : 0
    const remainingSec = Math.max(0, estimate - elapsedSec)
    const progress = Math.max(0.04, Math.min(0.97, elapsedSec / estimate))
    let label: string
    if (elapsedSec > estimate * 1.8) label = 'дольше обычного'
    else if (remainingSec <= 5) label = 'завершаем…'
    else label = `осталось ~${remainingSec < 60 ? `${remainingSec} с` : `${Math.ceil(remainingSec / 60)} мин`}`
    return { elapsedSec, remainingSec, progress, label }
}

export function normalizeArtistList(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const artists: string[] = []
    for (const item of value) {
        if (typeof item === 'string') {
            const name = sanitizeText(item, 120)
            if (name) artists.push(name)
        } else if (item && typeof item === 'object') {
            const name = sanitizeText((item as { name?: unknown }).name, 120)
            if (name) artists.push(name)
        }
    }
    return [...new Set(artists)]
}

export function normalizeTrackMeta(raw: unknown, fallback: TrackRef): TrackRef {
    if (!raw || typeof raw !== 'object') return fallback
    const data = raw as Record<string, unknown>
    const id = String(data.id ?? fallback.id)
    const title = sanitizeText(data.title ?? fallback.title, 300)
    const artists = normalizeArtistList(data.artists)
    const durationRaw = Number(data.durationMs ?? data.duration ?? 0)
    const durationMs = Number.isFinite(durationRaw) && durationRaw > 0
        ? durationRaw > 1000 * 20
            ? durationRaw
            : durationRaw * 1000
        : fallback.durationMs
    return {
        id: isYandexTrackId(id) ? id : fallback.id,
        title: title || fallback.title,
        artist: artists.join(', ') || fallback.artist,
        durationMs,
        albumId: typeof data.albumId === 'string' ? data.albumId : fallback.albumId,
    }
}

export function trackToSearchMeta(track: TrackRef): TrackSearchMeta {
    return {
        id: track.id,
        title: sanitizeText(track.title, 300),
        artist: sanitizeText(track.artist, 300),
        durationMs: Math.max(0, Math.round(Number(track.durationMs) || 0)),
    }
}

export function mappingTitle(mapping: TrackMapping): string {
    return mapping.title || `Трек ${mapping.trackId}`
}

export function mappingArtist(mapping: TrackMapping): string {
    return mapping.artists.filter(Boolean).join(', ')
}

export function libraryTracks(index: LibraryIndex | null): TrackMapping[] {
    if (!index) return []
    return Object.values(index.tracks)
        .filter(item => item && isYandexTrackId(item.trackId))
        .sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''))
}

export function truncate(value: string, max: number): string {
    if (value.length <= max) return value
    return `${value.slice(0, Math.max(0, max - 1))}…`
}

export function extractTrackArray(payload: unknown): unknown[] {
    if (Array.isArray(payload)) return payload
    if (!payload || typeof payload !== 'object') return []
    const object = payload as Record<string, unknown>
    if (Array.isArray(object.tracks)) return object.tracks
    if (Array.isArray(object.result)) return object.result
    if (object.result && typeof object.result === 'object') {
        const result = object.result as Record<string, unknown>
        if (Array.isArray(result.tracks)) return result.tracks
    }
    return []
}
