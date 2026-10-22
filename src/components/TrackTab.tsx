import { useEffect, useMemo, useRef, useState } from 'react'

import type { JobRecord, SourceCandidate, TrackRef } from '../types.ts'
import {
    formatDate,
    formatDuration,
    formatDurationLong,
    providerLabel,
    scorePercent,
    truncate,
} from '../lib/format.ts'
import {
    checkAudioUrl,
    confirmCandidate,
    isMappingEnabled,
    pauseForPreview,
    removeMapping,
    resolveTrackForUi,
    restoreMapping,
    setMappingEnabled,
    startManualAdd,
    startSearch,
} from '../store.ts'
import { useStore } from './useStore.ts'
import { PreviewPlayer } from './PreviewPlayer.tsx'

type Props = {
    initialTrack: TrackRef | null
    currentTrack: TrackRef | null
    initialAction?: 'search' | 'manual'
    onOpenJobs: () => void
}

function candidateWarnings(candidate: SourceCandidate): string[] {
    return candidate.warnings.filter(Boolean)
}

function durationDelta(targetMs: number, candidateMs: number): string {
    if (!targetMs || !candidateMs) return 'длительность не указана'
    const delta = Math.round((candidateMs - targetMs) / 1000)
    if (Math.abs(delta) <= 2) return 'длительность совпадает'
    return `длительность ${delta > 0 ? '+' : ''}${delta} с`
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
    const [manualPreview, setManualPreview] = useState('')
    const [manualPreviewed, setManualPreviewed] = useState(false)
    const [previewKey, setPreviewKey] = useState('')
    const [actionError, setActionError] = useState('')
    const [busy, setBusy] = useState('')
    const [confirmRemove, setConfirmRemove] = useState(false)
    const [urlCheck, setUrlCheck] = useState('')
    const initializedFor = useRef('')
    const lastSeedId = useRef('')
    const manualSection = useRef<HTMLDivElement | null>(null)

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

    useEffect(() => {
        if (initialAction === 'manual') {
            setTimeout(() => manualSection.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50)
        }
    }, [initialAction, track?.id])

    useEffect(() => {
        setPreviewKey('')
        setManualPreview('')
        setManualPreviewed(false)
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
            setActionError('Заполните исполнителя и название. Это улучшит поиск.')
            return
        }
        setBusy('search')
        try {
            await startSearch(track, resolvedMeta, sourceUrl.trim())
            setPreviewKey('')
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
            setPreviewKey('')
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error))
        } finally {
            setBusy('')
        }
    }

    const runManual = async () => {
        setActionError('')
        if (!manualPreviewed) {
            setActionError('Сначала прослушайте запись. Автоматическая проверка не доказывает отсутствие цензуры.')
            return
        }
        if (!manualUrl.trim()) {
            setActionError('Вставьте прямую ссылку на аудиофайл.')
            return
        }
        setBusy('manual')
        try {
            await startManualAdd(track, resolvedMeta, manualUrl.trim())
            setPreviewKey('')
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
            setUrlCheck(`${result.ok ? 'Доступен' : 'Проблема'}: ${result.message}${result.contentType ? ` (${result.contentType})` : ''}`)
        } finally {
            setBusy('')
        }
    }

    return (
        <div className="uc-stack">
            <section className="uc-card uc-track-card">
                <div className="uc-track-main">
                    <div>
                        <div className="uc-eyebrow">Трек Яндекс Музыки</div>
                        <div className="uc-track-title">{track.title || resolvedMeta.title || `Трек ${track.id}`}</div>
                        <div className="uc-muted">
                            {track.artist || resolvedMeta.artist || 'Исполнитель не указан'} · ID {track.id}
                            {track.durationMs ? ` · ${formatDuration(track.durationMs)}` : ''}
                        </div>
                    </div>
                    <div className={`uc-status-pill ${mapping ? (enabled ? 'uc-ok' : 'uc-warn') : ''}`}>
                        {mapping ? (enabled ? 'Замена активна' : 'Замена выключена') : 'Замены нет'}
                    </div>
                </div>
                {resolving ? <div className="uc-muted uc-small">Уточняем метаданные трека…</div> : null}
                {mapping ? (
                    <div className="uc-mapping">
                        <div className="uc-mapping-row">
                            <div>
                                <div className="uc-label">Облачная запись</div>
                                <a className="uc-link uc-break" href={mapping.audioUrl} target="_blank" rel="noreferrer">
                                    {truncate(mapping.audioUrl, 96)}
                                </a>
                                <div className="uc-muted uc-small">
                                    {providerLabel(mapping.source.provider)} · добавлено {formatDate(mapping.addedAt)}
                                    {mapping.source.pageUrl ? (
                                        <>
                                            {' · '}
                                            <a className="uc-link" href={mapping.source.pageUrl} target="_blank" rel="noreferrer">
                                                страница источника
                                            </a>
                                        </>
                                    ) : null}
                                </div>
                            </div>
                            <div className="uc-row-actions">
                                <button
                                    type="button"
                                    className={`uc-toggle ${enabled ? 'uc-toggle-on' : ''}`}
                                    disabled={busy === 'toggle'}
                                    onClick={() => void toggleMapping()}
                                >
                                    <span className="uc-toggle-dot" />
                                    {enabled ? 'Включена' : 'Выключена'}
                                </button>
                                {state.removed.includes(track.id) ? (
                                    <button type="button" className="uc-btn uc-btn-small" disabled={busy === 'restore'} onClick={() => {
                                        setBusy('restore')
                                        void restoreMapping(track.id).finally(() => setBusy(''))
                                    }}>
                                        Вернуть
                                    </button>
                                ) : null}
                            </div>
                        </div>
                        <div className="uc-row-actions uc-wrap">
                            <button type="button" className="uc-btn uc-btn-small" disabled={busy === 'check'} onClick={() => void verifyUrl()}>
                                Проверить файл
                            </button>
                            {confirmRemove ? (
                                <>
                                    <button type="button" className="uc-btn uc-btn-small uc-danger" disabled={busy === 'remove'} onClick={() => void remove()}>
                                        Да, убрать связь
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
                            <span className="uc-muted uc-small">Файл в Releases не удаляется.</span>
                        </div>
                        {urlCheck ? <div className={`uc-check ${urlCheck.startsWith('Доступен') ? 'uc-ok-text' : 'uc-error-text'}`}>{urlCheck}</div> : null}
                    </div>
                ) : null}
            </section>

            <section className="uc-card">
                <div className="uc-section-head">
                    <div>
                        <div className="uc-eyebrow">Поиск в облаке</div>
                        <div className="uc-section-title">Найти альтернативную запись</div>
                    </div>
                    <button type="button" className="uc-link" onClick={onOpenJobs}>
                        Задания
                    </button>
                </div>
                <div className="uc-hint">
                    Поиск идёт через GitHub Actions. Автоматическое совпадение названия не доказывает отсутствие цензуры:
                    обязательно прослушайте кандидата.
                </div>
                <div className="uc-grid uc-grid-2">
                    <label className="uc-field">
                        <span>Исполнитель</span>
                        <input value={artist} onChange={event => setArtist(event.target.value)} placeholder="Например, Кино" />
                    </label>
                    <label className="uc-field">
                        <span>Название</span>
                        <input value={title} onChange={event => setTitle(event.target.value)} placeholder="Название трека" />
                    </label>
                    <label className="uc-field">
                        <span>Длительность, секунд</span>
                        <input
                            type="number"
                            min={0}
                            max={7200}
                            value={durationSec || ''}
                            onChange={event => setDurationSec(Math.max(0, Number(event.target.value) || 0))}
                            placeholder="Например, 245"
                        />
                    </label>
                    <label className="uc-field">
                        <span>Страница YouTube/SoundCloud (необязательно)</span>
                        <input
                            value={sourceUrl}
                            onChange={event => setSourceUrl(event.target.value)}
                            placeholder="https://www.youtube.com/watch?v=…"
                        />
                    </label>
                </div>
                <div className="uc-row-actions uc-wrap">
                    <button type="button" className="uc-btn uc-btn-primary" disabled={busy === 'search' || !state.hasToken} onClick={() => void runSearch()}>
                        {busy === 'search' ? 'Отправляем…' : 'Искать в облаке'}
                    </button>
                    <button type="button" className="uc-btn" onClick={() => manualSection.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}>
                        Своя ссылка на аудио
                    </button>
                    {!state.hasToken ? <span className="uc-muted uc-small">Для поиска нужен токен в разделе «Мой GitHub».</span> : null}
                </div>
            </section>

            {searchJob ? (
                <section className="uc-card uc-candidates-card">
                    <div className="uc-section-head">
                        <div>
                            <div className="uc-eyebrow">Задание {searchJob.id.slice(0, 8)}</div>
                            <div className="uc-section-title">
                                {searchJob.status === 'ready' ? 'Кандидаты' : searchJob.status === 'queued' ? 'В очереди GitHub Actions' : 'Ищем и готовим аудио'}
                            </div>
                        </div>
                        {searchJob.runUrl ? (
                            <a className="uc-link uc-small" href={searchJob.runUrl} target="_blank" rel="noreferrer">
                                Журнал Actions
                            </a>
                        ) : null}
                    </div>
                    {searchJob.status !== 'ready' ? (
                        <div className="uc-progress-note">
                            <span className="uc-dot-pulse" />
                            Задание привязано к треку {searchJob.trackId}. Можно закрыть панель — поиск продолжится, статус
                            сохранится.
                        </div>
                    ) : null}
                    {searchJob.error ? <div className="uc-inline-error">{searchJob.error.message}</div> : null}
                    {searchJob.status === 'ready' ? (
                        <>
                            <div className="uc-hint">
                                Прослушайте записи и выберите ту, в которой нет цензуры. Кнопка сохранения публикует выбранный
                                файл в ваш GitHub Releases и привязывает его к ID {track.id}.
                            </div>
                            <div className="uc-candidate-list">
                                {(searchJob.candidates || []).length ? (
                                    (searchJob.candidates || [])
                                        .slice()
                                        .sort((a, b) => b.score - a.score)
                                        .map(candidate => {
                                            const key = `candidate:${candidate.id}`
                                            const confirming = busy === `confirm:${candidate.id}`
                                            return (
                                                <article className="uc-candidate" key={candidate.id}>
                                                    <div className="uc-candidate-head">
                                                        <div className="uc-candidate-title">{candidate.title}</div>
                                                        <div className="uc-badges">
                                                            <span className={`uc-badge uc-badge-${candidate.provider}`}>{providerLabel(candidate.provider)}</span>
                                                            <span className="uc-badge">совпадение {scorePercent(candidate.score)}</span>
                                                            <span className="uc-badge">{formatDuration(candidate.durationMs)}</span>
                                                        </div>
                                                    </div>
                                                    <div className="uc-muted uc-small">
                                                        {candidate.artist || candidate.uploader || 'Автор не указан'} · {durationDelta(track.durationMs || 0, candidate.durationMs)}
                                                    </div>
                                                    {candidateWarnings(candidate).length ? (
                                                        <div className="uc-warning-list">
                                                            {candidateWarnings(candidate).map(warning => (
                                                                <span className="uc-warn-badge" key={warning}>{warning}</span>
                                                            ))}
                                                        </div>
                                                    ) : null}
                                                    <PreviewPlayer
                                                        src={candidate.previewUrl}
                                                        title={candidate.title}
                                                        subtitle={`${providerLabel(candidate.provider)} · ${candidate.artist || candidate.uploader || 'автор не указан'}`}
                                                        durationMs={candidate.durationMs}
                                                        active={previewKey === key}
                                                        onActivate={() => setPreviewKey(key)}
                                                        onBeforePlay={async () => {
                                                            await pauseForPreview()
                                                        }}
                                                        pageUrl={candidate.pageUrl}
                                                        compact
                                                    />
                                                    <div className="uc-row-actions">
                                                        <button
                                                            type="button"
                                                            className="uc-btn uc-btn-primary uc-btn-small"
                                                            disabled={confirming || Boolean(confirmJob)}
                                                            onClick={() => void runConfirm(candidate)}
                                                        >
                                                            {confirming || confirmJob ? 'Сохраняем…' : 'Подменить и сохранить'}
                                                        </button>
                                                        <span className="uc-muted uc-small">
                                                            Запись будет скопирована в Releases и станет постоянной.
                                                        </span>
                                                    </div>
                                                </article>
                                            )
                                        })
                                ) : (
                                    <div className="uc-empty">
                                        <div className="uc-empty-title">Кандидатов нет</div>
                                        <div className="uc-muted">Измените название/исполнителя или укажите конкретную страницу источника.</div>
                                    </div>
                                )}
                            </div>
                        </>
                    ) : null}
                </section>
            ) : null}

            {confirmJob ? (
                <section className="uc-card uc-progress-note">
                    <span className="uc-dot-pulse" />
                    Публикуем выбранную запись в GitHub Releases и обновляем list.json. Не закрывайте задачу: статус сохранится
                    в разделе «Задания».
                </section>
            ) : null}

            <section className="uc-card" ref={manualSection}>
                <div className="uc-section-head">
                    <div>
                        <div className="uc-eyebrow">Ручное добавление</div>
                        <div className="uc-section-title">Своя ссылка на аудиофайл</div>
                    </div>
                </div>
                <div className="uc-hint">
                    Вставьте прямую HTTPS-ссылку на аудиофайл: m4a, mp3, aac, ogg, opus, flac или wav. Это может быть файл из
                    Releases вашего репозитория. Страница YouTube, SoundCloud или страница релиза не подойдёт.
                </div>
                <div className="uc-inline">
                    <input
                        className="uc-grow"
                        value={manualUrl}
                        onChange={event => {
                            setManualUrl(event.target.value)
                            setManualPreview('')
                            setManualPreviewed(false)
                        }}
                        placeholder="https://github.com/владелец/репозиторий/releases/download/library/track.m4a"
                    />
                    <button
                        type="button"
                        className="uc-btn"
                        disabled={!manualUrl.trim()}
                        onClick={() => {
                            setManualPreview(manualUrl.trim())
                            setManualPreviewed(false)
                            setActionError('')
                        }}
                    >
                        Проверить и прослушать
                    </button>
                </div>
                {manualPreview ? (
                    <PreviewPlayer
                        src={manualPreview}
                        title={title || 'Своя запись'}
                        subtitle={artist || 'Ручная ссылка'}
                        durationMs={resolvedMeta.durationMs}
                        active={previewKey === 'manual'}
                        onActivate={() => setPreviewKey('manual')}
                        onStarted={() => setManualPreviewed(true)}
                        onBeforePlay={async () => {
                            await pauseForPreview()
                        }}
                        pageUrl={manualPreview}
                        compact
                    />
                ) : null}
                <div className="uc-row-actions uc-wrap">
                    <button type="button" className="uc-btn uc-btn-primary" disabled={busy === 'manual' || !manualPreviewed || !state.hasToken} onClick={() => void runManual()}>
                        {busy === 'manual' ? 'Отправляем…' : 'Подменить и сохранить'}
                    </button>
                    <span className="uc-muted uc-small">
                        Файл будет скачан GitHub Actions, проверен и скопирован в Releases вашего репозитория.
                    </span>
                </div>
            </section>

            {actionError ? <div className="uc-inline-error">{actionError}</div> : null}
            <div className="uc-muted uc-small">
                Длительность: {formatDurationLong(resolvedMeta.durationMs)}. Поиск учитывает исполнителя, название,
                длительность и версию записи, но финальное решение всегда за вами.
            </div>
        </div>
    )
}
