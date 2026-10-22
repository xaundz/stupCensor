import { useEffect, useMemo, useState } from 'react'

import type { JobRecord, TrackRef } from '../types.ts'
import { formatDateTime, jobTiming, statusLabel } from '../lib/format.ts'
import { cancelJob, forgetJob, replaceableTrackFromJob } from '../store.ts'
import { useStore } from './useStore.ts'

type Props = {
    onOpenTrack: (track: TrackRef) => void
}

type Filter = 'active' | 'all'

function statusClass(job: JobRecord): string {
    if (job.status === 'failed') return 'uc-error'
    if (job.status === 'abandoned') return 'uc-warn'
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
            return 'Своя ссылка'
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
    const [now, setNow] = useState(Date.now())
    const [cancelling, setCancelling] = useState('')
    const [error, setError] = useState('')

    const pending = state.jobs.filter(job => job.status === 'queued' || job.status === 'running')

    const jobs = useMemo(() => {
        if (filter === 'all') return state.jobs
        return state.jobs.filter(job => job.status === 'queued' || job.status === 'running' || job.status === 'ready')
    }, [state.jobs, filter])

    useEffect(() => {
        if (!pending.length) return
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
    }, [pending.length, pending.map(job => `${job.id}:${job.status}:${job.startedAt || ''}`).join('|')])

    const cancel = async (job: JobRecord) => {
        setCancelling(job.id)
        setError('')
        try {
            await cancelJob(job.id)
        } catch (cancelError) {
            setError(cancelError instanceof Error ? cancelError.message : String(cancelError))
        } finally {
            setCancelling('')
        }
    }

    return (
        <div className="uc-stack">
            <section className="uc-card">
                <div className="uc-section-head">
                    <div>
                        <div className="uc-eyebrow">GitHub Actions</div>
                        <div className="uc-section-title">Задания</div>
                    </div>
                    <div className="uc-segmented">
                        <button type="button" className={filter === 'active' ? 'uc-segmented-active' : ''} onClick={() => setFilter('active')}>
                            Активные
                        </button>
                        <button type="button" className={filter === 'all' ? 'uc-segmented-active' : ''} onClick={() => setFilter('all')}>
                            Все
                        </button>
                    </div>
                </div>
                <div className="uc-muted uc-small">
                    {pending.length
                        ? `В работе ${pending.length}. Статусы обновляются сами.`
                        : filter === 'active'
                          ? 'Активных заданий нет.'
                          : 'История заданий за последнее время.'}
                </div>
                {error ? <div className="uc-inline-error">{error}</div> : null}

                <div className="uc-list">
                    {jobs.length ? jobs.map(job => {
                        const isPending = job.status === 'queued' || job.status === 'running'
                        const timing = isPending ? jobTiming(job, now) : null
                        return (
                            <article className="uc-list-item uc-job" key={job.id}>
                                <div className="uc-list-main">
                                    <div className="uc-list-title-row">
                                        <div className="uc-list-title">
                                            {job.trackArtist ? `${job.trackArtist} — ` : ''}
                                            {job.trackTitle || `Трек ${job.trackId}`}
                                        </div>
                                        <span className={`uc-status-pill ${statusClass(job)}`}>{statusLabel(job.status)}</span>
                                    </div>
                                    <div className="uc-muted uc-small">
                                        {actionLabel(job)} · {formatDateTime(job.createdAt)}
                                        {job.status === 'ready' ? ` · кандидатов: ${job.candidates?.length || 0}` : ''}
                                        {timing ? ` · ${timing.label}` : ''}
                                    </div>
                                    {timing ? (
                                        <div className="uc-progress-track uc-progress-small" aria-hidden="true">
                                            <span style={{ width: `${Math.max(4, Math.round(timing.progress * 100))}%` }} />
                                        </div>
                                    ) : null}
                                    {job.error ? (
                                        <div className="uc-inline-error">
                                            {job.error.message}
                                            {job.error.detail ? <span className="uc-muted uc-small"> · {job.error.detail}</span> : null}
                                        </div>
                                    ) : null}
                                </div>
                                <div className="uc-list-actions">
                                    {job.action === 'search' && (job.status === 'ready' || isPending) ? (
                                        <button
                                            type="button"
                                            className="uc-btn uc-btn-small uc-btn-primary"
                                            onClick={() => onOpenTrack(replaceableTrackFromJob(job))}
                                        >
                                            {job.status === 'ready' ? 'Кандидаты' : 'Открыть'}
                                        </button>
                                    ) : job.trackId ? (
                                        <button type="button" className="uc-btn uc-btn-small" onClick={() => onOpenTrack(replaceableTrackFromJob(job))}>
                                            Трек
                                        </button>
                                    ) : null}
                                    {isPending ? (
                                        <button
                                            type="button"
                                            className="uc-btn uc-btn-small uc-danger"
                                            disabled={cancelling === job.id}
                                            onClick={() => void cancel(job)}
                                        >
                                            {cancelling === job.id ? 'Отменяем…' : 'Отменить'}
                                        </button>
                                    ) : (
                                        <button type="button" className="uc-link uc-small" onClick={() => forgetJob(job.id)}>
                                            Скрыть
                                        </button>
                                    )}
                                    {job.runUrl ? (
                                        <a className="uc-link uc-small" href={job.runUrl} target="_blank" rel="noreferrer">
                                            Журнал
                                        </a>
                                    ) : null}
                                </div>
                            </article>
                        )
                    }) : (
                        <div className="uc-empty">
                            <div className="uc-empty-title">{filter === 'active' ? 'Активных заданий нет' : 'Заданий пока нет'}</div>
                            <div className="uc-muted">Запустите поиск из карточки трека. Он продолжится при закрытой панели.</div>
                        </div>
                    )}
                </div>
                <div className="uc-muted uc-small">История хранится локально до 30 записей.</div>
            </section>
        </div>
    )
}
