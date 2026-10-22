import { useEffect, useMemo, useRef, useState } from 'react'

import type { JobRecord, SourceCandidate, TrackRef } from '../types.ts'
import {
    formatDate,
    formatDuration,
    formatDurationLong,
    jobTiming,
    providerLabel,
    scorePercent,
} from '../lib/format.ts'
import {
    cancelJob,
    checkAudioUrl,
    confirmCandidate,
    isMappingEnabled,
    removeMapping,
    resolveTrackForUi,
    restoreMapping,
    setMappingEnabled,
    startManualAdd,
    startSearch,
} from '../store.ts'
import { useStore } from './useStore.ts'

type Props = {
    initialTrack: TrackRef | null
    currentTrack: TrackRef | null
    initialAction?: 'search' | 'manual'
    onOpenJobs: () => void
}

function durationDelta(targetMs: number, candidateMs: number): string {
    if (!targetMs || !candidateMs) return 'длительность не указана'
    const delta = Math.round((candidateMs - targetMs) / 1000)
    if (Math.abs(delta) <= 2) return 'длительность совпадает'
    return `длительность ${delta > 0 ? '+' : ''}${delta} с`
}

function pendingLabel(job: JobRecord): string {
    if (job.status === 'queued') return 'В очереди GitHub Actions'
    if (job.action === 'search') return 'Ищем подходящие записи'
    return 'Публикуем выбранную запись'
}

export function TrackTab({ initialTrack, currentTrack, initialAction, onOpenJobs }: Props) {
    const state = useStore()
    const seed = initialTrack ?? currentTrack
    const [track, setTrack] = useState<TrackRef | null>(seed)
    const [resolving, setResolving] = useState(false)
    const [title, setTitle] = useState(seed?.title || '')
    const [artist, setArtist] = useState(seed?.artist || '')
    const [durationSec, setDurationSec] = useState(Math.round((seed?.durationMs || 0) / 1000))
    const [sourceUrl, setSourceUrl] = useState('')
    const [manualUrl, setManualUrl] = useState('')
    const [manualOpen, setManualOpen] = useState(initialAction === 'manual')
    const [actionError, setActionError] = useState('')
    const [busy, setBusy] = useState('')
    const [confirmRemove, setConfirmRemove] = useState(false)
    const [urlCheck, setUrlCheck] = useState('')
    const [now, setNow] = useState(Date.now())
    const initializedFor = useRef('')
    const lastSeedId = useRef('')
    const manualSection = useRef<HTMLDetailsElement | null>(null)

    useEffect(() => {
        if (!seed?.id) {
            setTrack(null)
            return
        }
        let cancelled = false
        if (lastSeedId.current !== seed.id) {
            lastSeedId.current = seed.id
            initializedFor.current = ''
            setTitle(seed.title || '')
            setArtist(seed.artist || '')
            setDurationSec(Math.max(0, Math.round((seed.durationMs || 0) / 1000)))
        }
        setTrack(seed)
        setResolving(true)
        void resolveTrackForUi(seed)
            .then(resolved => {
                if (cancelled) return
                setTrack(resolved)
                if (initializedFor.current !== resolved.id) {
                    initializedFor.current = resolved.id
                    setTitle(resolved.title || '')
                    setArtist(resolved.artist || '')
                    setDurationSec(Math.max(0, Math.round((resolved.durationMs || 0) / 1000)))
                }
            })
            .catch(() => {
                if (!cancelled) setTrack(seed)
            })
            .finally(() => {
                if (!cancelled) setResolving(false)
            })
        return () => {
            cancelled = true
        }
    }, [seed?.id, seed?.title, seed?.artist, seed?.durationMs])

    const mapping = track ? state.library.tracks[track.id] : null
    const enabled = mapping ? isMappingEnabled(mapping) : false
    const searchJob = useMemo<JobRecord | null>(() => {
        if (!track) return null
        return (
            state.jobs.find(
                job =>
                    job.trackId === track.id &&
                    job.action === 'search' &&
                    (job.status === 'ready' || job.status === 'queued' || job.status === 'running'),
            ) ?? null
        )
    }, [state.jobs, track])
    const confirmJob = useMemo<JobRecord | null>(() => {
        if (!track) return null
        return (
            state.jobs.find(
                job =>
                    job.trackId === track.id &&
                    job.action === 'confirm' &&
                    (job.status === 'queued' || job.status === 'running'),
            ) ?? null
        )
    }, [state.jobs, track])
    const activeJob = confirmJob ?? (searchJob && searchJob.status !== 'ready' ? searchJob : null)

    useEffect(() => {
        if (!activeJob) return
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
    }, [activeJob?.id, activeJob?.status, activeJob?.startedAt])

    useEffect(() => {
        if (initialAction !== 'manual') return
        setManualOpen(true)
        window.setTimeout(() => manualSection.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50)
    }, [initialAction, track?.id])

    useEffect(() => {
        setActionError('')
        setUrlCheck('')
        setConfirmRemove(false)
    }, [track?.id])

    const resolvedMeta = useMemo(
        () => ({
            id: track?.id || '',
            title: title.trim(),
            artist: artist.trim(),
            durationMs: Math.max(0, Math.round(durationSec || 0) * 1000),
        }),
        [track?.id, title, artist, durationSec],
    )

    if (!track) {
        return (
            <div className="uc-empty">
                <div className="uc-empty-title">Трек не выбран</div>
                <div className="uc-muted">
                    Откройте меню трека (три точки) и выберите «Найти без цензуры» или «stupidCensor: открыть».
                </div>
            </div>
        )
    }

    const runSearch = async () => {
        setActionError('')
        if (!title.trim() || !artist.trim()) {
            setActionError('Заполните исполнителя и название.')
            return
        }
        setBusy('search')
        try {
            await startSearch(track, resolvedMeta, sourceUrl.trim())
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error))
        } finally {
            setBusy('')
        }
    }

    const runConfirm = async (candidate: SourceCandidate) => {
        if (!searchJob) return
        setActionError('')
        setBusy(`confirm:${candidate.id}`)
        try {
            await confirmCandidate(searchJob, candidate)
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error))
        } finally {
            setBusy('')
        }
    }

    const runManual = async () => {
        setActionError('')
        if (!manualUrl.trim()) {
            setActionError('Вставьте прямую ссылку на аудиофайл.')
            return
        }
        setBusy('manual')
        try {
            await startManualAdd(track, resolvedMeta, manualUrl.trim())
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error))
        } finally {
            setBusy('')
        }
    }

    const toggleMapping = async () => {
        if (!mapping) return
        setBusy('toggle')
        try {
            await setMappingEnabled(track.id, !enabled)
        } finally {
            setBusy('')
        }
    }

    const remove = async () => {
        setBusy('remove')
        try {
            await removeMapping(track.id)
            setConfirmRemove(false)
        } finally {
            setBusy('')
        }
    }

    const verifyUrl = async () => {
        if (!mapping) return
        setBusy('check')
        setUrlCheck('')
        try {
            const result = await checkAudioUrl(mapping.audioUrl)
            setUrlCheck(`${result.ok ? 'Доступен' : 'Проблема'}: ${result.message}`)
        } finally {
            setBusy('')
        }
    }

    const cancelActive = async () => {
        if (!activeJob) return
        setBusy(`cancel:${activeJob.id}`)
        setActionError('')
        try {
            await cancelJob(activeJob.id)
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error))
        } finally {
            setBusy('')
        }
    }

    const timing = activeJob ? jobTiming(activeJob, now) : null
    const readyCandidates = searchJob?.status === 'ready' ? (searchJob.candidates || []).slice().sort((a, b) => b.score - a.score) : []

    return (
        <div className="uc-stack">
            <section className="uc-card uc-track-card">
                <div className="uc-track-main">
                    <div className="uc-track-copy">
                        <div className="uc-eyebrow">Сейчас в фокусе</div>
                        <div className="uc-track-title">{track.title || resolvedMeta.title || `Трек ${track.id}`}</div>
                        <div className="uc-muted">
                            {track.artist || resolvedMeta.artist || 'Исполнитель не указан'}
                            {track.durationMs ? ` · ${formatDuration(track.durationMs)}` : ''}
                        </div>
                    </div>
                    <div className={`uc-status-pill ${mapping ? (enabled ? 'uc-ok' : 'uc-warn') : ''}`}>
                        {mapping ? (enabled ? 'Замена активна' : 'Замена выключена') : 'Замены нет'}
                    </div>
                </div>
                {resolving ? <div className="uc-muted uc-small uc-mt">Уточняем метаданные…</div> : null}
                {mapping ? (
                    <div className="uc-mapping">
                        <div className="uc-mapping-row">
                            <div className="uc-min0">
                                <div className="uc-label">Источник</div>
                                <div className="uc-source-line">
                                    {providerLabel(mapping.source.provider)}
                                    {mapping.source.pageUrl ? (
                                        <a className="uc-link" href={mapping.source.pageUrl} target="_blank" rel="noreferrer">
                                            открыть страницу
                                        </a>
                                    ) : null}
                                    <span className="uc-muted">· {formatDate(mapping.addedAt)}</span>
                                </div>
                            </div>
                            <div className="uc-row-actions uc-mt-0">
                                <button
                                    type="button"
                                    className={`uc-toggle ${enabled ? 'uc-toggle-on' : ''}`}
                                    disabled={busy === 'toggle'}
                                    onClick={() => void toggleMapping()}
                                    title={enabled ? 'Выключить замену' : 'Включить замену'}
                                >
                                    <span className="uc-toggle-dot" />
                                    {enabled ? 'Вкл.' : 'Выкл.'}
                                </button>
                                {state.removed.includes(track.id) ? (
                                    <button
                                        type="button"
                                        className="uc-btn uc-btn-small"
                                        disabled={busy === 'restore'}
                                        onClick={() => {
                                            setBusy('restore')
                                            void restoreMapping(track.id).finally(() => setBusy(''))
                                        }}
                                    >
                                        Вернуть
                                    </button>
                                ) : null}
                            </div>
                        </div>
                        <details className="uc-more">
                            <summary>Файл и удаление</summary>
                            <div className="uc-more-body">
                                <a className="uc-link uc-break" href={mapping.audioUrl} target="_blank" rel="noreferrer">
                                    {mapping.audioUrl}
                                </a>
                                <div className="uc-row-actions uc-wrap">
                                    <button type="button" className="uc-btn uc-btn-small" disabled={busy === 'check'} onClick={() => void verifyUrl()}>
                                        Проверить файл
                                    </button>
                                    {confirmRemove ? (
                                        <>
                                            <button type="button" className="uc-btn uc-btn-small uc-danger" disabled={busy === 'remove'} onClick={() => void remove()}>
                                                Убрать связь
                                            </button>
                                            <button type="button" className="uc-btn uc-btn-small" onClick={() => setConfirmRemove(false)}>
                                                Отмена
                                            </button>
                                        </>
                                    ) : (
                                        <button type="button" className="uc-btn uc-btn-small" onClick={() => setConfirmRemove(true)}>
                                            Удалить связь
                                        </button>
                                    )}
                                    <span className="uc-muted uc-small">Файл в Releases остаётся.</span>
                                </div>
                                {urlCheck ? (
                                    <div className={`uc-check ${urlCheck.startsWith('Доступен') ? 'uc-ok-text' : 'uc-error-text'}`}>{urlCheck}</div>
                                ) : null}
                            </div>
                        </details>
                    </div>
                ) : null}
            </section>

            {activeJob && timing ? (
                <section className="uc-card uc-progress-card">
                    <div className="uc-section-head">
                        <div>
                            <div className="uc-eyebrow">GitHub Actions</div>
                            <div className="uc-section-title">{pendingLabel(activeJob)}</div>
                        </div>
                        <span className="uc-eta">{timing.label}</span>
                    </div>
                    <div className="uc-progress-track" aria-hidden="true">
                        <span style={{ width: `${Math.max(4, Math.round(timing.progress * 100))}%` }} />
                    </div>
                    <div className="uc-muted uc-small uc-mt">
                        Можно закрыть панель: задание продолжится, статус сохранится.
                    </div>
                    <div className="uc-row-actions uc-wrap">
                        <button
                            type="button"
                            className="uc-btn uc-btn-small"
                            disabled={busy === `cancel:${activeJob.id}`}
                            onClick={() => void cancelActive()}
                        >
                            {busy === `cancel:${activeJob.id}` ? 'Отменяем…' : 'Отменить'}
                        </button>
                        {activeJob.runUrl ? (
                            <a className="uc-link uc-small" href={activeJob.runUrl} target="_blank" rel="noreferrer">
                                Журнал Actions
                            </a>
                        ) : null}
                        {activeJob.status === 'running' && activeJob.error ? (
                            <span className="uc-error-text uc-small">{activeJob.error.message}</span>
                        ) : null}
                    </div>
                </section>
            ) : null}

            {!activeJob ? (
                <section className="uc-card">
                    <div className="uc-section-head">
                        <div>
                            <div className="uc-eyebrow">Поиск</div>
                            <div className="uc-section-title">
                                {readyCandidates.length ? `${readyCandidates.length} кандидатов` : 'Найти замену'}
                            </div>
                        </div>
                        <button type="button" className="uc-link uc-small" onClick={onOpenJobs}>
                            Задания
                        </button>
                    </div>

                    {readyCandidates.length ? (
                        <>
                            <div className="uc-hint">
                                Файл скачается и проверится только после нажатия «Сохранить». До этого в Releases ничего не
                                публикуется.
                            </div>
                            <div className="uc-candidate-list">
                                {readyCandidates.map(candidate => {
                                    const confirming = busy === `confirm:${candidate.id}`
                                    return (
                                        <article className="uc-candidate" key={candidate.id}>
                                            <div className="uc-candidate-main">
                                                <div className="uc-candidate-title">{candidate.title}</div>
                                                <div className="uc-muted uc-small">
                                                    {candidate.artist || candidate.uploader || 'Автор не указан'} ·{' '}
                                                    {durationDelta(track.durationMs || 0, candidate.durationMs)}
                                                </div>
                                                <div className="uc-badges uc-mt">
                                                    <span className={`uc-badge uc-badge-${candidate.provider}`}>
                                                        {providerLabel(candidate.provider)}
                                                    </span>
                                                    <span className="uc-badge">{scorePercent(candidate.score)}</span>
                                                    <span className="uc-badge">{formatDuration(candidate.durationMs)}</span>
                                                    {candidate.warnings.slice(0, 3).map(warning => (
                                                        <span className="uc-warn-badge" key={warning}>{warning}</span>
                                                    ))}
                                                </div>
                                            </div>
                                            <div className="uc-candidate-actions">
                                                <a className="uc-link uc-small" href={candidate.pageUrl} target="_blank" rel="noreferrer">
                                                    Источник
                                                </a>
                                                <button
                                                    type="button"
                                                    className="uc-btn uc-btn-primary uc-btn-small"
                                                    disabled={confirming}
                                                    onClick={() => void runConfirm(candidate)}
                                                >
                                                    {confirming ? 'Отправляем…' : 'Сохранить'}
                                                </button>
                                            </div>
                                        </article>
                                    )
                                })}
                            </div>
                            <details className="uc-more uc-more-after">
                                <summary>Искать заново</summary>
                                <div className="uc-more-body">
                                    <SearchFields
                                        artist={artist}
                                        title={title}
                                        durationSec={durationSec}
                                        sourceUrl={sourceUrl}
                                        onArtist={setArtist}
                                        onTitle={setTitle}
                                        onDuration={setDurationSec}
                                        onSource={setSourceUrl}
                                    />
                                    <div className="uc-row-actions">
                                        <button type="button" className="uc-btn" disabled={busy === 'search' || !state.hasToken} onClick={() => void runSearch()}>
                                            {busy === 'search' ? 'Отправляем…' : 'Искать заново'}
                                        </button>
                                    </div>
                                </div>
                            </details>
                        </>
                    ) : (
                        <>
                            <div className="uc-hint">
                                Поиск читает только названия, авторов и длительность. Аудио скачивается после выбора.
                            </div>
                            <div className="uc-search-primary">
                                <button
                                    type="button"
                                    className="uc-btn uc-btn-primary"
                                    disabled={busy === 'search' || !state.hasToken}
                                    onClick={() => void runSearch()}
                                >
                                    {busy === 'search' ? 'Отправляем…' : 'Найти замену'}
                                </button>
                                <span className="uc-muted uc-small">
                                    {state.hasToken ? 'Обычно 30–60 секунд.' : 'Нужен токен в разделе «GitHub».'}
                                </span>
                            </div>
                            <details className="uc-more uc-more-after">
                                <summary>Уточнить запрос</summary>
                                <div className="uc-more-body">
                                    <SearchFields
                                        artist={artist}
                                        title={title}
                                        durationSec={durationSec}
                                        sourceUrl={sourceUrl}
                                        onArtist={setArtist}
                                        onTitle={setTitle}
                                        onDuration={setDurationSec}
                                        onSource={setSourceUrl}
                                    />
                                    <div className="uc-row-actions">
                                        <button type="button" className="uc-btn" disabled={busy === 'search' || !state.hasToken} onClick={() => void runSearch()}>
                                            Искать с этими данными
                                        </button>
                                    </div>
                                </div>
                            </details>
                        </>
                    )}
                </section>
            ) : null}

            <details
                className="uc-card uc-manual"
                ref={manualSection}
                open={manualOpen}
                onToggle={event => setManualOpen((event.currentTarget as HTMLDetailsElement).open)}
            >
                <summary>
                    <span>Добавить свою ссылку</span>
                    <span className="uc-muted uc-small">прямой HTTPS-файл</span>
                </summary>
                <div className="uc-manual-body">
                    <div className="uc-hint">
                        Подойдёт постоянная ссылка на m4a, mp3, aac, ogg, opus, flac или wav. Страница YouTube или
                        SoundCloud — нет.
                    </div>
                    <div className="uc-inline">
                        <input
                            className="uc-grow"
                            value={manualUrl}
                            onChange={event => setManualUrl(event.target.value)}
                            placeholder="https://github.com/…/releases/download/library/track.m4a"
                        />
                        <button
                            type="button"
                            className="uc-btn uc-btn-primary"
                            disabled={busy === 'manual' || !manualUrl.trim() || !state.hasToken}
                            onClick={() => void runManual()}
                        >
                            {busy === 'manual' ? 'Отправляем…' : 'Сохранить'}
                        </button>
                    </div>
                </div>
            </details>

            {actionError ? <div className="uc-inline-error">{actionError}</div> : null}
            <div className="uc-muted uc-small">
                {formatDurationLong(resolvedMeta.durationMs)} · проверка не определяет цензуру, финальное решение за вами.
            </div>
        </div>
    )
}

type SearchFieldsProps = {
    artist: string
    title: string
    durationSec: number
    sourceUrl: string
    onArtist: (value: string) => void
    onTitle: (value: string) => void
    onDuration: (value: number) => void
    onSource: (value: string) => void
}

function SearchFields({ artist, title, durationSec, sourceUrl, onArtist, onTitle, onDuration, onSource }: SearchFieldsProps) {
    return (
        <div className="uc-grid uc-grid-2">
            <label className="uc-field">
                <span>Исполнитель</span>
                <input value={artist} onChange={event => onArtist(event.target.value)} placeholder="Например, Кино" />
            </label>
            <label className="uc-field">
                <span>Название</span>
                <input value={title} onChange={event => onTitle(event.target.value)} placeholder="Название трека" />
            </label>
            <label className="uc-field">
                <span>Длительность, секунд</span>
                <input
                    type="number"
                    min={0}
                    max={7200}
                    value={durationSec || ''}
                    onChange={event => onDuration(Math.max(0, Number(event.target.value) || 0))}
                    placeholder="245"
                />
            </label>
            <label className="uc-field">
                <span>Страница источника</span>
                <input
                    value={sourceUrl}
                    onChange={event => onSource(event.target.value)}
                    placeholder="YouTube или SoundCloud, необязательно"
                />
            </label>
        </div>
    )
}
