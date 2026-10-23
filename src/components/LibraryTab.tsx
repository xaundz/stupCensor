import { useMemo, useState } from 'react'

import type { TrackMapping, TrackRef } from '../types.ts'
import { formatDate, formatDuration, providerLabel, pluralRu } from '../lib/format.ts'
import {
    isMappingEnabled,
    isRepositoryAdmin,
    refreshLibrary,
    removeMapping,
    restoreMapping,
    setMappingEnabled,
} from '../store.ts'
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
    const admin = isRepositoryAdmin()
    const [query, setQuery] = useState('')
    const [filter, setFilter] = useState<Filter>('all')
    const [busyId, setBusyId] = useState('')
    const [confirmId, setConfirmId] = useState('')

    const all = useMemo(() => Object.values(state.library.tracks), [state.library])
    const counts = useMemo(() => {
        let active = 0
        let removed = 0
        for (const mapping of all) {
            if (state.removed.includes(mapping.trackId)) removed += 1
            else if (isMappingEnabled(mapping)) active += 1
        }
        return { active, removed, total: all.length }
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
                    mapping.artists.join(' ').toLowerCase().includes(needle)
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
                        <div className="uc-section-title">Замены</div>
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
                <div className="uc-muted uc-small">
                    {counts.total
                        ? `${counts.total} ${pluralRu(counts.total, 'запись', 'записи', 'записей')} · ${counts.active} активны${counts.removed ? ` · ${counts.removed} скрыто` : ''}`
                        : 'Библиотека пуста'}
                    {state.libraryFetchedAt ? ` · обновлено ${formatDate(state.libraryFetchedAt)}` : ''}
                    {state.libraryFromCache ? ' · кэш' : ''}
                </div>

                {!state.config ? (
                    <div className="uc-empty">
                        <div className="uc-empty-title">Сначала подключите GitHub</div>
                        <div className="uc-muted">Библиотека читается из вашего публичного репозитория.</div>
                        <button type="button" className="uc-btn uc-btn-primary" onClick={onOpenSetup}>Открыть GitHub</button>
                    </div>
                ) : (
                    <>
                        <div className="uc-inline uc-wrap uc-mt">
                            <input
                                className="uc-grow"
                                value={query}
                                onChange={event => setQuery(event.target.value)}
                                placeholder="Исполнитель, название или ID"
                            />
                            <div className="uc-segmented">
                                {([
                                    ['all', 'Все'],
                                    ['active', 'Активные'],
                                    ['disabled', 'Выкл.'],
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
                                const globallyDisabled = !mapping.enabled
                                return (
                                    <article className="uc-list-item" key={mapping.trackId}>
                                        <div className="uc-list-main">
                                            <div className="uc-list-title-row">
                                                <button type="button" className="uc-title-link" onClick={() => onOpenTrack(trackRef(mapping))}>
                                                    {mapping.title}
                                                </button>
                                                <span className={`uc-status-pill ${removed ? 'uc-warn' : enabled ? 'uc-ok' : ''}`}>
                                                    {removed ? 'Скрыта' : enabled ? 'Активна' : 'Выключена'}
                                                </span>
                                            </div>
                                            <div className="uc-muted uc-small">
                                                {mapping.artists.join(', ') || 'Исполнитель не указан'} · {formatDuration(mapping.durationMs)} ·{' '}
                                                {providerLabel(mapping.source.provider)}
                                                {mapping.source.pageUrl ? (
                                                    <>
                                                        {' · '}
                                                        <a className="uc-link" href={mapping.source.pageUrl} target="_blank" rel="noreferrer">
                                                            источник
                                                        </a>
                                                    </>
                                                ) : null}
                                            </div>
                                        </div>
                                        <div className="uc-list-actions">
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
                                                    disabled={busy || (!admin && globallyDisabled)}
                                                    title={!admin && globallyDisabled ? 'Замена отключена владельцем библиотеки' : undefined}
                                                    onClick={() => void toggle(mapping)}
                                                >
                                                    <span className="uc-toggle-dot" />
                                                    {enabled ? 'Вкл.' : 'Выкл.'}
                                                </button>
                                            )}
                                            {confirmId === mapping.trackId ? (
                                                <>
                                                    <button type="button" className="uc-link uc-small uc-error-text" disabled={busy} onClick={() => void remove(mapping)}>
                                                        {admin ? 'Точно удалить' : 'Точно скрыть'}
                                                    </button>
                                                    <button type="button" className="uc-link uc-small" onClick={() => setConfirmId('')}>
                                                        Нет
                                                    </button>
                                                </>
                                            ) : (
                                                <button type="button" className="uc-link uc-small" onClick={() => setConfirmId(mapping.trackId)}>
                                                    {admin ? 'Удалить' : 'Скрыть у себя'}
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
                            {admin
                                ? '«Удалить» убирает связь из list.json и аудиофайлы трека из Releases.'
                                : '«Скрыть у себя» не меняет общую библиотеку. Удалять из GitHub может только владелец.'}
                        </div>
                    </>
                )}
            </section>
        </div>
    )
}
