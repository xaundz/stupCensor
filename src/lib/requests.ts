import type { JobRecord } from '../types.ts'
import { isStableHttpsUrl, isYandexTrackId, normalizeRepoInput, sanitizeText } from './format.ts'

export function buildRequestUrl(job: JobRecord, sourceUrl = ''): string {
    const repo = normalizeRepoInput(job.repo)
    if (!repo || !isYandexTrackId(job.trackId) || !['search', 'confirm', 'manual'].includes(job.action)) {
        throw new Error('Некорректный трек для заявки.')
    }
    const clean = (value: string, limit: number): string => sanitizeText(value, limit)
        .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[redacted]')
        .replace(/`/g, "'")
    let source: string | undefined
    if (sourceUrl) {
        const url = new URL(sourceUrl)
        if (!isStableHttpsUrl(sourceUrl) || url.username || url.password || url.hash ||
            /(?:token|secret|password|credential|signature|api[_-]?key|authorization)/i.test(url.search) ||
            /(?:github_pat_|gh[pousr]_)/.test(sourceUrl) || sourceUrl.length > 1000) {
            throw new Error('Нужна публичная ссылка без паролей и токенов, не длиннее 1000 символов.')
        }
        source = url.href
    }
    const duration = Number(job.trackDurationMs)
    const payload = {
        id: clean(job.id, 120),
        action: job.action,
        trackId: job.trackId,
        title: clean(job.trackTitle, 200),
        artist: clean(job.trackArtist, 200),
        duration: Number.isFinite(duration) ? Math.max(0, Math.round(duration / 1000)) : 0,
        ...(source ? { sourceUrl: source } : {}),
        ...(job.sourceJobId ? { sourceJobId: clean(job.sourceJobId, 120) } : {}),
        ...(job.candidateId ? { candidateId: clean(job.candidateId, 120) } : {}),
    }
    const body = 'stupidcensor-request-v1\n```json\n' + JSON.stringify(payload) + '\n```'
    const url = new URL(`https://github.com/${repo}/issues/new`)
    url.searchParams.set('title', `[uncensor-request] ${job.action}: ${payload.artist} - ${payload.title}`)
    url.searchParams.set('body', body)
    if (url.href.length > 6000) throw new Error('Заявка длиннее 6000 символов. Сократите название или ссылку.')
    return url.href
}
