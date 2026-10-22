import { useEffect, useRef, useState } from 'react'

import { formatDuration } from '../lib/format.ts'

type Props = {
    src: string
    title: string
    subtitle: string
    durationMs?: number
    active: boolean
    onActivate: () => void
    onBeforePlay: () => Promise<void>
    onStarted?: () => void
    pageUrl?: string
    compact?: boolean
}

function mediaErrorMessage(error: MediaError | null): string {
    if (!error) return 'Не удалось воспроизвести файл.'
    switch (error.code) {
        case 1:
            return 'Воспроизведение прервано.'
        case 2:
            return 'Ошибка сети при загрузке аудио.'
        case 3:
            return 'Формат аудио не поддерживается плеером.'
        case 4:
            return 'Файл недоступен или сервер не поддерживает воспроизведение.'
        default:
            return 'Не удалось воспроизвести файл.'
    }
}

export function PreviewPlayer({ src, title, subtitle, durationMs, active, onActivate, onBeforePlay, onStarted, pageUrl, compact }: Props) {
    const audioRef = useRef<HTMLAudioElement | null>(null)
    const [playing, setPlaying] = useState(false)
    const [loading, setLoading] = useState(false)
    const [position, setPosition] = useState(0)
    const [duration, setDuration] = useState(Math.max(0, (durationMs || 0) / 1000))
    const [error, setError] = useState('')

    useEffect(() => {
        if (active) return
        const audio = audioRef.current
        if (audio && !audio.paused) {
            audio.pause()
            setPlaying(false)
        }
    }, [active])

    useEffect(() => {
        return () => {
            const audio = audioRef.current
            if (!audio) return
            audio.pause()
            audio.removeAttribute('src')
            audio.load()
        }
    }, [])

    const toggle = async () => {
        const audio = audioRef.current
        if (!audio) return
        setError('')
        if (!audio.paused) {
            audio.pause()
            setPlaying(false)
            return
        }
        onActivate()
        setLoading(true)
        const pauseRequest = onBeforePlay()
        try {
            await audio.play()
            setPlaying(true)
            await pauseRequest
            if (!audio.paused) onStarted?.()
        } catch {
            setError('Не удалось начать предпросмотр или поставить Яндекс Музыку на паузу.')
            audio.pause()
            setPlaying(false)
        } finally {
            setLoading(false)
        }
    }

    const seek = (value: number) => {
        const audio = audioRef.current
        if (!audio || !Number.isFinite(value)) return
        audio.currentTime = value
        setPosition(value)
    }

    const progressMax = duration > 0 ? duration : 0
    return (
        <div className={`uc-preview${compact ? ' uc-preview-compact' : ''}`}>
            <audio
                ref={audioRef}
                src={src}
                preload="none"
                onLoadedMetadata={event => {
                    const value = event.currentTarget.duration
                    if (Number.isFinite(value) && value > 0) setDuration(value)
                }}
                onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onWaiting={() => setLoading(true)}
                onCanPlay={() => setLoading(false)}
                onEnded={() => {
                    setPlaying(false)
                    setPosition(0)
                }}
                onError={event => {
                    setLoading(false)
                    setPlaying(false)
                    setError(mediaErrorMessage(event.currentTarget.error))
                }}
            />
            <div className="uc-preview-head">
                <button type="button" className="uc-play" onClick={() => void toggle()} aria-label={playing ? 'Пауза' : 'Слушать'}>
                    {loading ? '…' : playing ? '❚❚' : '▶'}
                </button>
                <div className="uc-preview-meta">
                    <div className="uc-preview-title" title={title}>{title}</div>
                    <div className="uc-preview-sub">{subtitle}</div>
                </div>
                {pageUrl ? (
                    <a className="uc-link uc-small" href={pageUrl} target="_blank" rel="noreferrer">
                        Источник
                    </a>
                ) : null}
            </div>
            <div className="uc-preview-controls">
                <span className="uc-time">{formatDuration(position * 1000)}</span>
                <input
                    className="uc-range"
                    type="range"
                    min={0}
                    max={progressMax || 0}
                    step={0.1}
                    value={Math.min(position, progressMax || 0)}
                    onChange={event => seek(Number(event.target.value))}
                    aria-label="Позиция предпросмотра"
                />
                <span className="uc-time">{formatDuration((progressMax || 0) * 1000)}</span>
            </div>
            {error ? <div className="uc-inline-error">{error}</div> : null}
        </div>
    )
}
