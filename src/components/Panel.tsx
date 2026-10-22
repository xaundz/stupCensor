import { useEffect, useState } from 'react'

import { ADDON_AUTHOR, ADDON_NAME, ADDON_VERSION } from '../legacy/constants.ts'
import { useCurrentTrack } from '../legacy/useCurrentTrack.ts'
import type { TrackRef } from '../types.ts'
import { clearNotice } from '../store.ts'
import { LibraryTab } from './LibraryTab.tsx'
import { JobsTab } from './JobsTab.tsx'
import { SettingsTab } from './SettingsTab.tsx'
import { TrackTab } from './TrackTab.tsx'
import { useStore } from './useStore.ts'

type Tab = 'track' | 'library' | 'jobs' | 'setup'

export type PanelController = {
    readonly signal: AbortSignal
    close: (confirmed?: boolean) => void
}

export type PanelProps = {
    controller: PanelController
    initialTrack?: TrackRef | null
    initialTab?: Tab
    initialAction?: 'search' | 'manual'
}

const TABS: Array<[Tab, string]> = [
    ['track', 'Трек'],
    ['library', 'Библиотека'],
    ['jobs', 'Задания'],
    ['setup', 'GitHub'],
]

export function Panel({ controller, initialTrack, initialTab, initialAction }: PanelProps) {
    const state = useStore()
    const current = useCurrentTrack()
    const [tab, setTab] = useState<Tab>(initialTab ?? 'track')
    const [selected, setSelected] = useState<TrackRef | null>(initialTrack ?? null)

    const currentRef: TrackRef | null = current
        ? {
              id: current.id,
              title: current.title,
              artist: (current.artists || []).map(artist => artist.name).filter(Boolean).join(', '),
              durationMs: current.durationMs || (current.duration ? current.duration * 1000 : undefined),
              albumId: current.albums?.[0]?.id === undefined ? undefined : String(current.albums[0].id),
          }
        : null

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') controller.close()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [controller])

    useEffect(() => {
        if (!state.notice) return
        const timer = window.setTimeout(() => clearNotice(), 9000)
        return () => window.clearTimeout(timer)
    }, [state.notice])

    const openTrack = (track: TrackRef) => {
        setSelected(track)
        setTab('track')
    }

    const notice = state.notice
    return (
        <div className="uc-panel">
            <header className="uc-header">
                <div className="uc-brand">
                    <div className="uc-mark">SC</div>
                    <div>
                        <div className="uc-brand-title">{ADDON_NAME}</div>
                        <div className="uc-brand-sub">
                            {state.config ? `${state.config.repo}@${state.config.branch}` : 'Облачная библиотека замен'}
                        </div>
                    </div>
                </div>
                <div className="uc-header-actions">
                    <span className={`uc-conn ${state.config ? (state.hasToken ? 'uc-ok' : 'uc-warn') : 'uc-warn'}`}>
                        {state.config ? (state.hasToken ? 'GitHub подключён' : 'Только чтение') : 'Не подключён'}
                    </span>
                    <button type="button" className="uc-close" aria-label="Закрыть" onClick={() => controller.close()}>
                        ×
                    </button>
                </div>
            </header>

            <nav className="uc-tabs" aria-label={`Разделы ${ADDON_NAME}`}>
                {TABS.map(([value, label]) => (
                    <button
                        type="button"
                        key={value}
                        className={tab === value ? 'uc-tab uc-tab-active' : 'uc-tab'}
                        onClick={() => setTab(value)}
                    >
                        {label}
                        {value === 'jobs' && state.jobs.some(job => job.status === 'queued' || job.status === 'running') ? (
                            <span className="uc-tab-dot" />
                        ) : null}
                    </button>
                ))}
            </nav>

            {notice ? (
                <div className={`uc-notice uc-notice-${notice.kind}`}>
                    <span>{notice.text}</span>
                    <button type="button" className="uc-notice-close" aria-label="Скрыть уведомление" onClick={() => clearNotice()}>
                        ×
                    </button>
                </div>
            ) : null}
            {state.lastError && !notice ? (
                <div className="uc-notice uc-notice-error">
                    <span>{state.lastError}</span>
                </div>
            ) : null}

            <main className="uc-body">
                {tab === 'track' ? (
                    <TrackTab
                        initialTrack={selected}
                        currentTrack={currentRef}
                        initialAction={initialAction}
                        onOpenJobs={() => setTab('jobs')}
                    />
                ) : null}
                {tab === 'library' ? (
                    <LibraryTab onOpenTrack={openTrack} onOpenSetup={() => setTab('setup')} />
                ) : null}
                {tab === 'jobs' ? <JobsTab onOpenTrack={openTrack} /> : null}
                {tab === 'setup' ? <SettingsTab /> : null}
            </main>

            <footer className="uc-footer">
                <span>{ADDON_NAME} {ADDON_VERSION} · {ADDON_AUTHOR}</span>
                <span className="uc-muted">Токен хранится только в PulseSync.</span>
            </footer>
        </div>
    )
}
