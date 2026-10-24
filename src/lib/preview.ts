export type SourcePreviewUrl = {
    provider: 'youtube' | 'soundcloud'
    embedUrl: string
    sourceUrl: string
}

export function getSourcePreview(provider: string, pageUrl: string): SourcePreviewUrl | null {
    let url: URL
    try {
        url = new URL(pageUrl)
    } catch {
        return null
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null

    if (provider === 'youtube') {
        let id: string | null = null
        if (url.hostname === 'youtu.be') {
            id = /^\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)?.[1] ?? null
        } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
            id = url.pathname === '/watch'
                ? url.searchParams.get('v')
                : /^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)?.[1] ?? null
        }
        if (!id || id.length !== 11 || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null
        return {
            provider,
            embedUrl: `https://www.youtube.com/embed/${id}?autoplay=0`,
            sourceUrl: `https://www.youtube.com/watch?v=${id}`,
        }
    }

    if (provider === 'soundcloud' && ['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname)) {
        const path = /^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)
        if (!path || ['discover', 'search', 'stream', 'you', 'settings', 'upload', 'pages', 'terms', 'charts'].includes(path[1].toLowerCase())) return null
        // Never forward private-link tokens or arbitrary query parameters to the widget.
        if ([...url.searchParams.keys()].some(key => /token|secret|password|auth|key/i.test(key))) return null
        const sourceUrl = `https://soundcloud.com/${path[1]}/${path[2]}`
        return {
            provider,
            embedUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(sourceUrl)}&auto_play=false&visual=false`,
            sourceUrl,
        }
    }
    return null
}
