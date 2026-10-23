import type { TrackRef } from '../types.ts'

type QueueMeta = {
    id?: string | number
    title?: string
    duration?: number
    durationMs?: number
    artists?: Array<{ name?: string }>
    albums?: Array<{ id?: string | number }>
}

type QueueItem = {
    entity?: {
        hidden?: boolean
        data?: { meta?: QueueMeta }
        entityData?: { meta?: QueueMeta }
    }
}

export function readQueueTracks(): TrackRef[] {
    const items = window.pulsesyncApi?.getQueue() as QueueItem[] | undefined
    if (!Array.isArray(items)) return []
    const tracks: TrackRef[] = []
    const seen = new Set<string>()
    for (const item of items) {
        if (item?.entity?.hidden) continue
        const meta = item?.entity?.data?.meta ?? item?.entity?.entityData?.meta
        if (!meta?.id) continue
        const id = String(meta.id)
        if (seen.has(id)) continue
        seen.add(id)
        tracks.push({
            id,
            title: meta.title,
            artist: (meta.artists || []).map(artist => artist.name).filter(Boolean).join(', '),
            durationMs: meta.durationMs || (meta.duration ? meta.duration * 1000 : undefined),
            albumId: meta.albums?.[0]?.id === undefined ? undefined : String(meta.albums[0].id),
        })
    }
    return tracks
}
