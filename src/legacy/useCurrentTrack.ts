import type { PulseSyncTrackMeta } from '@pulsesync/yamusic-types'
import { useCallback, useSyncExternalStore } from 'react'

export function useCurrentTrack(): PulseSyncTrackMeta | null {
    const pulsesync = window.pulsesyncApi
    const subscribe = useCallback(
        (onChange: () => void) => {
            if (!pulsesync) return () => undefined
            const off = pulsesync.onCurrentTrackChange(() => onChange())
            return () => {
                off()
            }
        },
        [pulsesync],
    )
    const getSnapshot = useCallback(() => pulsesync?.getCurrentTrack() ?? null, [pulsesync])
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
