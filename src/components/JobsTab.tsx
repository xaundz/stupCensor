import { useMemo, useState } from 'react'

import type { JobRecord, TrackRef } from '../types.ts'
import { formatDateTime, statusLabel } from '../lib/format.ts'
import { forgetJob, pollPendingJobs, replaceableTrackFromJob } from '../store.ts'
import { useStore } from './useStore.ts'

type Props = {
    onOpenTrack: (track: TrackRef) => void
}

type Filter = 'active' | 'all'

function statusClass(job: JobRecord): string {
    if (job.status === 'failed') return 'uc-error'
    if (job.status === 'ready' || job.status === 'published' || job.status === 'updated' || job.status === 'removed') return 'uc-ok'
    return 'uc-warn'
}

function actionLabel(job: JobRecord): string {
    switch (job.action) {
        case 'search':
            return 'Поиск'
        case 'confirm':
            return 'Публикация'
        case 'manual':
            return 'Ручное добавление'
        case 'toggle':
            return 'Переключение'
        case 'remove':
            return 'Удаление'
        default:
            return job.action
    }
}

export function JobsTab({ onOpenTrack }: Props) {
    const state = useStore()
    const [filter, setFilter] = useState<Filter>('active')

    const jobs = useMemo(() => {
        if (filter === 'all') return state.jobs
        return state.jobs.filter(job => job.status === 'queued' || job.status === 'running' || job.status === 'ready')
    }, [state.jobs, filter])

    const pending = state.jobs.filter(job => job.status === 'queued' || job.status === 'running').length

    return (
        <div className="uc-stack">
            <section className="uc-card">
                <div className="uc-section-head">
                    <div>
                        <div className="uc-eyebrow">GitHub Actions</div>
                        <div className="uc-section-title">Задания</div>
                    </div>
                    <div className="uc-row-actions">
                        <div className="uc-segmented">
                            <button type="button" className={filter === 'active' ? 'uc-segmented-active' : ''} onClick={() => setFilter('active')}>
                                Активные
                            </button>
                            <button type="button" className={filter === 'all' ? 'uc-segmented-active' : ''} onClick={() => setFilter('all')}>
                                Все
                            </button>
                        </div>
                        <button type="button" className="uc-btn uc-btn-small" disabled={!state.hasToken || !pending} onClick={() => void pollPendingJobs()}>
                            Проверить
                        </button>
                    </div>
                </div>
                <div className="uc-muted uc-small">
                    {pending ? `В работе ${pending}. Статусы обновляются автоматически.` : 'Активных заданий нет.'}
                    {!state.hasToken ? ' Без токена новые задания не запускаются.' : ''}
                </div>
                <div className="uc-list">
                    {jobs.length ? jobs.map(job => (
                        <article className="uc-list-item uc-job" key={job.id}>
                            <div className="uc-list-main">
                                <div className="uc-list-title-row">
                                    <div className="uc-list-title">
                                        {job.trackArtist ? `${job.trackArtist} — ` : ''}{job.trackTitle || `Трек ${job.trackId}`}
                                    </div>
                                    <span className={`uc-status-pill ${statusClass(job)}`}>{statusLabel(job.status)}</span>
                                </div>
                                <div className="uc-muted uc-small">
                                    {actionLabel(job)} · {job.id.slice(0, 8)} · создано {formatDateTime(job.createdAt)}
                                    {job.status === 'ready' ? ` · кандидатов: ${job.candidates?.length || 0}` : ''}
                                    {job.silent ? ' · служебное' : ''}
                                </div>
                                {job.error ? (
                                    <div className="uc-inline-error">
                                        {job.error.message}
                                        {job.error.detail ? <span className="uc-muted uc-small"> · {job.error.detail}</span> : null}
                                    </div>
                                ) : null}
                            </div>
                            <div className="uc-list-actions">
                                {job.runUrl ? (
                                    <a className="uc-btn uc-btn-small" href={job.runUrl} target="_blank" rel="noreferrer">
                                        Actions
                                    </a>
                                ) : null}
                                {job.action === 'search' && (job.status === 'ready' || job.status === 'running' || job.status === 'queued') ? (
                                    <button type="button" className="uc-btn uc-btn-small uc-btn-primary" onClick={() => onOpenTrack(replaceableTrackFromJob(job))}>
                                        {job.status === 'ready' ? 'Кандидаты' : 'Открыть трек'}
                                    </button>
                                ) : null}
                                {job.action !== 'search' && job.trackId ? (
                                    <button type="button" className="uc-btn uc-btn-small" onClick={() => onOpenTrack(replaceableTrackFromJob(job))}>
                                        Трек
                                    </button>
                                ) : null}
                                {job.status !== 'queued' && job.status !== 'running' ? (
                                    <button type="button" className="uc-btn uc-btn-small" onClick={() => forgetJob(job.id)}>
                                        Скрыть
                                    </button>
                                ) : null}
                            </div>
                        </article>
                    )) : (
                        <div className="uc-empty">
                            <div className="uc-empty-title">{filter === 'active' ? 'Активных заданий нет' : 'Заданий пока нет'}</div>
                            <div className="uc-muted">
                                Откройте трек и нажмите «Искать в облаке». Задание появится здесь и продолжится при закрытой панели.
                            </div>
                        </div>
                    )}
                </div>
                <div className="uc-muted uc-small">
                    Задание хранится локально до 30 записей. Состояние на сервере может истечь через несколько дней.
                </div>
            </section>
        </div>
    )
}
