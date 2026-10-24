import type { SourcePreviewUrl } from '../lib/preview.ts'

type Props = {
    preview: SourcePreviewUrl
    title: string
    onClose: () => void
}

export function SourcePreview({ preview, title, onClose }: Props) {
    const service = preview.provider === 'youtube' ? 'YouTube' : 'SoundCloud'
    return (
        <div className="uc-source-preview">
            <div className="uc-section-head">
                <span className="uc-label">Прослушивание · {service}</span>
                <button type="button" className="uc-btn uc-btn-small" onClick={onClose}>
                    Закрыть прослушивание
                </button>
            </div>
            <div className="uc-hint">
                Приостановите трек Яндекс Музыки вручную. Сервис может запретить встраивание.
                Прослушивание не гарантирует скачивание, в том числе из-за DRM.
            </div>
            <iframe
                className={`uc-preview-frame uc-preview-frame-${preview.provider}`}
                src={preview.embedUrl}
                title={`${service}: ${title}`}
                referrerPolicy="strict-origin-when-cross-origin"
                allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                sandbox="allow-scripts allow-same-origin allow-presentation"
                allowFullScreen
            />
            <a className="uc-link uc-small" href={preview.sourceUrl} target="_blank" rel="noreferrer">
                Открыть источник в браузере
            </a>
        </div>
    )
}
