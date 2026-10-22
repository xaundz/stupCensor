import { useSyncExternalStore } from 'react'

import { getState, subscribe, type StoreState } from '../store.ts'

export function useStore(): StoreState {
    return useSyncExternalStore(subscribe, getState, getState)
}
