import { useMemo, useState } from 'react'

import type { TrackMapping, TrackRef } from '../types.ts'
import { formatDate, formatDuration, providerLabel, truncate } from '../lib/format.ts'
import { isMappingEnabled, refreshLibrary, removeMapping, restoreMapping, setMappingEnabled } from '../store.ts'
import { useStore } from './useStore.ts'

type Props = {
    onOpenTrack: (track: TrackRef) => void
    onOpenSetup: () => void
}

type Filter = 'all' | 'active' | 'disabled' | 'removed'

function trackRef(mapping: TrackMapping): TrackRef {
    return {
        id: mapping.trackId,
        title: mapping.title,
        artist: mapping.artists.join(', '),
        durationMs: mapping.durationMs,
    }
}

export function LibraryTab({ onOpenTrack, onOpenSetup }: Props) {
    const state = useStore()
    const [query, setQuery] = useState('')
    const [filter, setFilter] = useState<Filter>('all')
    const [busyId, setBusyId] = useState('')
    const [confirmId, setConfirmId] = useState('')

    const all = useMemo(() => Object.values(state.library.tracks), [state.library])
    const counts = useMemo(() => {
        let active = 0
        let disabled = 0
        let removed = 0
        for (const mapping of all) {
            if (state.removed.includes(mapping.trackId)) removed += 1
            else if (isMappingEnabled(mapping)) active += 1
            else disabled += 1
        }
        return { active, disabled, removed, total: all.length }
    }, [all, state.disabled, state.removed])

    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase()
        return all
            .filter(mapping => {
                if (filter === 'active') return isMappingEnabled(mapping)
                if (filter === 'disabled') return !isMappingEnabled(mapping) && !state.removed.includes(mapping.trackId)
                if (filter === 'removed') return state.removed.includes(mapping.trackId)
                return true
            })
            .filter(mapping => {
                if (!needle) return true
                return (
                    mapping.trackId.includes(needle) ||
                    mapping.title.toLowerCase().includes(needle) ||
                    mapping.artists.join(' ').toLowerCase().includes(needle) ||
                    mapping.audioUrl.toLowerCase().includes(needle)
                )
            })
            .sort((a, b) => {
                const left = `${a.artists[0] || ''} ${a.title}`.toLowerCase()
                const right = `${b.artists[0] || ''} ${b.title}`.toLowerCase()
                return left.localeCompare(right, 'ru')
            })
    }, [all, filter, query, state.disabled, state.removed])

    const toggle = async (mapping: TrackMapping) => {
        setBusyId(mapping.trackId)
        try {
            await setMappingEnabled(mapping.trackId, !isMappingEnabled(mapping))
        } finally {
            setBusyId('')
        }
    }

    const remove = async (mapping: TrackMapping) => {
        setBusyId(mapping.trackId)
        try {
            await removeMapping(mapping.trackId)
            setConfirmId('')
        } finally {
            setBusyId('')
        }
    }

    return (
        <div className="uc-stack">
            <section className="uc-card">
                <div className="uc-section-head">
                    <div>
                        <div className="uc-eyebrow">Публичная библиотека</div>
                        <div className="uc-section-title">Замены из list.json</div>
                    </div>
                    <button
                        type="button"
                        className="uc-btn uc-btn-small"
                        disabled={state.busy === 'library' || !state.config}
                        onClick={() => void refreshLibrary().catch(() => undefined)}
                    >
                        {state.busy === 'library' ? 'Обновляем…' : 'Обновить'}
                    </button>
                </div>
                <div className="uc-stats">
                    <div className="uc-stat"><strong>{counts.total}</strong><span>всего</span></div>
                    <div className="uc-stat"><strong>{counts.active}</strong><span>активных</span></div>
                    <div className="uc-stat"><strong>{counts.disabled}</strong><span>выключено</span></div>
                    <div className="uc-stat"><strong>{counts.removed}</strong><span>скрыто</span></div>
                </div>
                <div className="uc-muted uc-small">
                    {state.libraryFetchedAt ? `Обновлено ${formatDate(state.libraryFetchedAt)}` : 'Библиотека ещё не загружена'}
                    {state.libraryFromCache ? ' · показаны кэшированные данные' : ''}
                    {state.config ? ` · ${state.config.repo}@${state.config.branch}` : ''}
                </div>
                {!state.config ? (
                    <div className="uc-empty">
                        <div className="uc-empty-title">Сначала подключите GitHub</div>
                        <div className="uc-muted">Библиотека читается из публичного репозитория, который вы настроите.</div>
                        <button type="button" className="uc-btn uc-btn-primary" onClick={onOpenSetup}>Открыть «Мой GitHub»</button>
                    </div>
                ) : (
                    <>
                        <div className="uc-inline uc-wrap">
                            <input
                                className="uc-grow"
                                value={query}
                                onChange={event => setQuery(event.target.value)}
                                placeholder="Фильтр: исполнитель, название или ID"
                            />
                            <div className="uc-segmented">
                                {([
                                    ['all', 'Все'],
                                    ['active', 'Активные'],
                                    ['disabled', 'Выключенные'],
                                    ['removed', 'Скрытые'],
                                ] as Array<[Filter, string]>).map(([value, label]) => (
                                    <button
                                        type="button"
                                        key={value}
                                        className={filter === value ? 'uc-segmented-active' : ''}
                                        onClick={() => setFilter(value)}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="uc-list">
                            {visible.length ? visible.map(mapping => {
                                const enabled = isMappingEnabled(mapping)
                                const removed = state.removed.includes(mapping.trackId)
                                const busy = busyId === mapping.trackId
                                return (
                                    <article className="uc-list-item" key={mapping.trackId}>
                                        <div className="uc-list-main">
                                            <div className="uc-list-title-row">
                                                <div className="uc-list-title">{mapping.title}</div>
                                                <span className={`uc-status-pill ${removed ? 'uc-warn' : enabled ? 'uc-ok' : ''}`}>
                                                    {removed ? 'Скрыта' : enabled ? 'Активна' : 'Выключена'}
                                                </span>
                                            </div>
                                            <div className="uc-muted uc-small">
                                                {mapping.artists.join(', ') || 'Исполнитель не указан'} · {formatDuration(mapping.durationMs)} · ID {mapping.trackId}
                                            </div>
                                            <div className="uc-muted uc-small">
                                                {providerLabel(mapping.source.provider)} · {formatDate(mapping.addedAt)} ·{' '}
                                                <a className="uc-link" href={mapping.audioUrl} target="_blank" rel="noreferrer">
                                                    {truncate(mapping.audioUrl, 70)}
                                                </a>
                                            </div>
                                        </div>
                                        <div className="uc-list-actions">
                                            <button type="button" className="uc-btn uc-btn-small" onClick={() => onOpenTrack(trackRef(mapping))}>
                                                Открыть
                                            </button>
                                            {removed ? (
                                                <button
                                                    type="button"
                                                    className="uc-btn uc-btn-small"
                                                    disabled={busy}
                                                    onClick={() => {
                                                        setBusyId(mapping.trackId)
                                                        void restoreMapping(mapping.trackId).finally(() => setBusyId(''))
                                                    }}
                                                >
                                                    Вернуть
                                                </button>
                                            ) : (
                                                <button
                                                    type="button"
                                                    className={`uc-toggle ${enabled ? 'uc-toggle-on' : ''}`}
                                                    disabled={busy}
                                                    onClick={() => void toggle(mapping)}
                                                >
                                                    <span className="uc-toggle-dot" />
                                                    {enabled ? 'Вкл.' : 'Выкл.'}
                                                </button>
                                            )}
                                            {confirmId === mapping.trackId ? (
                                                <>
                                                    <button type="button" className="uc-btn uc-btn-small uc-danger" disabled={busy} onClick={() => void remove(mapping)}>
                                                        Убрать
                                                    </button>
                                                    <button type="button" className="uc-btn uc-btn-small" onClick={() => setConfirmId('')}>
                                                        Нет
                                                    </button>
                                                </>
                                            ) : (
                                                <button type="button" className="uc-btn uc-btn-small" onClick={() => setConfirmId(mapping.trackId)}>
                                                    Удалить
                                                </button>
                                            )}
                                        </div>
                                    </article>
                                )
                            }) : (
                                <div className="uc-empty">
                                    <div className="uc-empty-title">Ничего не найдено</div>
                                    <div className="uc-muted">Измените фильтр или обновите библиотеку.</div>
                                </div>
                            )}
                        </div>
                        <div className="uc-muted uc-small">
                            «Удалить» скрывает связь в вашем облачном индексе. Аудиофайл в Releases остаётся доступным.
                        </div>
                    </>
                )}
            </section>
        </div>
    )
}
