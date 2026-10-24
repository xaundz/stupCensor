import { useEffect, useMemo, useState } from 'react'

import type { JobRecord, TrackRef } from '../types.ts'
import { formatDateTime, jobTiming, statusLabel } from '../lib/format.ts'
import { readQueueTracks } from '../lib/queue.ts'
import {
    cancelJob,
    forgetJob,
    isMappingEnabled,
    isRepositoryAdmin,
    refreshJob,
    replaceableTrackFromJob,
    startBatchSearch,
} from '../store.ts'
import { useStore } from './useStore.ts'

type Props = {
    onOpenTrack: (track: TrackRef) => void
}

type Filter = 'active' | 'all'

function statusClass(job: JobRecord): string {
    if (job.status === 'failed') return job.error?.code === 'rejected' ? 'uc-warn' : 'uc-error'
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
        case 'check':
            return 'Проверка YouTube'
        default:
            return job.action
    }
}

export function JobsTab({ onOpenTrack }: Props) {
    const state = useStore()
    const admin = isRepositoryAdmin()
    const [filter, setFilter] = useState<Filter>('active')
    const [queueTracks, setQueueTracks] = useState<TrackRef[]>(() => readQueueTracks())
    const [batchBusy, setBatchBusy] = useState(false)
    const [batchResult, setBatchResult] = useState('')
    const [batchError, setBatchError] = useState('')
    const [now, setNow] = useState(Date.now())
    const [cancelling, setCancelling] = useState('')
    const [refreshing, setRefreshing] = useState('')
    const [error, setError] = useState('')

    const pending = state.jobs.filter(job => job.status === 'queued' || job.status === 'running')
    const awaiting = state.jobs.filter(job => job.status === 'awaiting_approval')
    const ready = state.jobs.filter(job => job.status === 'ready' && job.action !== 'check')
    const queueMissing = queueTracks.filter(track => {
        const mapping = state.library.tracks[track.id]
        return !mapping || !isMappingEnabled(mapping)
    })

    const jobs = useMemo(() => {
        if (filter === 'all') return state.jobs
        return state.jobs.filter(
            job =>
                job.status === 'queued' ||
                job.status === 'running' ||
                job.status === 'ready' ||
                job.status === 'awaiting_approval',
        )
    }, [state.jobs, filter])

    useEffect(() => {
        if (!pending.length) return
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
    }, [pending.length, pending.map(job => `${job.id}:${job.status}:${job.startedAt || ''}`).join('|')])

    const refreshQueue = () => {
        setQueueTracks(readQueueTracks())
        setBatchResult('')
        setBatchError('')
    }

    const runBatch = async () => {
        setBatchBusy(true)
        setBatchResult('')
        setBatchError('')
        try {
            const result = await startBatchSearch(queueMissing, 10)
            setBatchResult(`Запущено: ${result.started} · пропущено: ${result.skipped} · ошибок: ${result.failed}`)
            setQueueTracks(readQueueTracks())
        } catch (batchFailure) {
            setBatchError(batchFailure instanceof Error ? batchFailure.message : String(batchFailure))
        } finally {
            setBatchBusy(false)
        }
    }

    const refreshStatus = async (job: JobRecord) => {
        setRefreshing(job.id)
        setError('')
        try {
            await refreshJob(job.id)
        } catch (refreshError) {
            setError(refreshError instanceof Error ? refreshError.message : String(refreshError))
        } finally {
            setRefreshing('')
        }
    }

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
            {admin ? <section className="uc-card">
                <div className="uc-section-head">
                    <div>
                        <div className="uc-eyebrow">Текущая очередь</div>
                        <div className="uc-section-title">Массовый поиск</div>
                    </div>
                    <button type="button" className="uc-link uc-small" onClick={refreshQueue}>
                        Обновить очередь
                    </button>
                </div>
                <div className="uc-muted uc-small">
                    В очереди {queueTracks.length}. Без активной замены: {queueMissing.length}. За один раз
                    запускается до 10 поисков.
                </div>
                <div className="uc-row-actions uc-wrap uc-mt">
                    <button
                        type="button"
                        className="uc-btn uc-btn-primary uc-btn-small"
                        disabled={batchBusy || !state.hasToken || !queueMissing.length}
                        onClick={() => void runBatch()}
                    >
                        {batchBusy ? 'Запускаем…' : `Искать ${Math.min(queueMissing.length, 10) || ''}`.trim()}
                    </button>
                    <span className="uc-muted uc-small">
                        {state.hasToken ? 'Каждый трек станет отдельным заданием GitHub Actions.' : 'Для запуска нужен GitHub-токен.'}
                    </span>
                </div>
                {batchResult ? <div className="uc-check uc-ok-text">{batchResult}</div> : null}
                {batchError ? <div className="uc-inline-error">{batchError}</div> : null}
            </section> : null}

            <section className="uc-card">
                <div className="uc-section-head">
                    <div>
                        <div className="uc-eyebrow">{admin ? 'GitHub Actions' : 'Проверка владельцем'}</div>
                        <div className="uc-section-title">{admin ? 'Задания' : 'Мои заявки'}</div>
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
                        : filter === 'active' && (awaiting.length || ready.length)
                          ? [
                                awaiting.length ? `На проверке у владельца: ${awaiting.length}` : '',
                                ready.length ? `Готовы кандидаты: ${ready.length}` : '',
                            ]
                                .filter(Boolean)
                                .join(' · ') + '.'
                          : filter === 'active'
                            ? 'Активных заданий нет.'
                            : 'История заданий за последнее время.'}
                </div>
                {error ? <div className="uc-inline-error">{error}</div> : null}

                <div className="uc-list">
                    {jobs.length ? jobs.map(job => {
                        const isPending = job.status === 'queued' || job.status === 'running'
                        const isAwaiting = job.status === 'awaiting_approval'
                        const timing = isPending ? jobTiming(job, now) : null
                        return (
                            <article className="uc-list-item uc-job" key={job.id}>
                                <div className="uc-list-main">
                                    <div className="uc-list-title-row">
                                        <div className="uc-list-title">
                                            {job.trackArtist ? `${job.trackArtist} — ` : ''}
                                            {job.trackTitle || `Трек ${job.trackId}`}
                                        </div>
                                        <span className={`uc-status-pill ${statusClass(job)}`}>
                                            {job.action === 'check' && job.status === 'ready'
                                                ? 'Проверка пройдена'
                                                : statusLabel(job.status, job.error?.code)}
                                        </span>
                                    </div>
                                    <div className="uc-muted uc-small">
                                        {actionLabel(job)} · {formatDateTime(job.createdAt)}
                                        {job.status === 'ready' && job.action !== 'check'
                                            ? ` · кандидатов: ${job.candidates?.length || 0}`
                                            : ''}
                                        {job.requestedBy ? ` · заявка от ${job.requestedBy}` : ''}
                                        {timing ? ` · ${timing.label}` : ''}
                                    </div>
                                    {timing ? (
                                        <div className="uc-progress-track uc-progress-small" aria-hidden="true">
                                            <span style={{ width: `${Math.max(4, Math.round(timing.progress * 100))}%` }} />
                                        </div>
                                    ) : null}
                                    {job.note ? <div className="uc-hint">{job.note}</div> : null}
                                    {job.error ? (
                                        <div className="uc-inline-error">
                                            {job.error.message}
                                            {job.error.detail ? <span className="uc-muted uc-small"> · {job.error.detail}</span> : null}
                                        </div>
                                    ) : null}
                                </div>
                                <div className="uc-list-actions">
                                    {job.externalRequest && !job.issueUrl && job.requestUrl && isPending ? (
                                        <a className="uc-btn uc-btn-primary uc-btn-small" href={job.requestUrl} target="_blank" rel="noreferrer">
                                            Отправить в GitHub
                                        </a>
                                    ) : null}
                                    {job.action === 'search' && (job.status === 'ready' || isPending) ? (
                                        <button
                                            type="button"
                                            className="uc-btn uc-btn-small uc-btn-primary"
                                            onClick={() => onOpenTrack(replaceableTrackFromJob(job))}
                                        >
                                            {job.status === 'ready' ? 'Кандидаты' : 'Открыть'}
                                        </button>
                                    ) : job.trackId && job.action !== 'check' ? (
                                        <button type="button" className="uc-btn uc-btn-small" onClick={() => onOpenTrack(replaceableTrackFromJob(job))}>
                                            Трек
                                        </button>
                                    ) : null}
                                    {isAwaiting ? (
                                        <button
                                            type="button"
                                            className="uc-btn uc-btn-small"
                                            disabled={refreshing === job.id}
                                            onClick={() => void refreshStatus(job)}
                                        >
                                            {refreshing === job.id ? 'Проверяем…' : 'Проверить'}
                                        </button>
                                    ) : null}
                                    {job.issueUrl ? (
                                        <a className="uc-link uc-small" href={job.issueUrl} target="_blank" rel="noreferrer">
                                            Заявка
                                        </a>
                                    ) : null}
                                    {isPending ? (
                                        <button
                                            type="button"
                                            className="uc-btn uc-btn-small uc-danger"
                                            disabled={cancelling === job.id}
                                            onClick={() => void cancel(job)}
                                        >
                                            {cancelling === job.id ? 'Отменяем…' : job.externalRequest ? 'Скрыть отслеживание' : 'Отменить'}
                                        </button>
                                    ) : (
                                        <button type="button" className="uc-link uc-small" onClick={() => forgetJob(job.id)}>
                                            Скрыть
                                        </button>
                                    )}
                                    {admin && job.runUrl ? (
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
