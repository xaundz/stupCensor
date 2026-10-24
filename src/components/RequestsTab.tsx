import { useEffect, useRef, useState } from 'react'

import { isRepositoryAdmin, listReviewRequests, reviewRequest } from '../store.ts'
import { useStore } from './useStore.ts'

type ReviewRequest = Awaited<ReturnType<typeof listReviewRequests>>[number]

export function RequestsTab() {
    const state = useStore()
    const admin = isRepositoryAdmin()
    const [requests, setRequests] = useState<ReviewRequest[]>([])
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState(0)
    const [error, setError] = useState('')
    const [sent, setSent] = useState<Record<number, string>>({})
    const [refresh, setRefresh] = useState(0)
    const session = useRef(0)
    const submitting = useRef(false)
    const repo = state.config?.repo || ''
    const viewer = state.repoInfo?.viewer || ''
    const issuesUrl = `https://github.com/${repo}/issues?q=is%3Aissue+is%3Aopen+label%3Auncensor-request`

    useEffect(() => {
        const current = ++session.current
        setRequests([])
        setSent({})
        setError('')
        setBusy(0)
        submitting.current = false
        return () => { session.current = current + 1 }
    }, [repo, viewer, admin])

    useEffect(() => {
        if (!admin) return
        let cancelled = false
        setLoading(true)
        setError('')
        void listReviewRequests().then(items => {
            if (!cancelled) setRequests(items)
        }).catch((loadError: unknown) => {
            if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError))
        }).finally(() => {
            if (!cancelled) setLoading(false)
        })
        return () => { cancelled = true }
    }, [repo, viewer, admin, refresh])

    const decide = async (request: ReviewRequest, decision: 'approved' | 'rejected') => {
        if (submitting.current || sent[request.number] || !isRepositoryAdmin()) return
        submitting.current = true
        const current = session.current
        setBusy(request.number)
        setError('')
        try {
            await reviewRequest(request.number, decision)
            if (current !== session.current) return
            setSent(previous => ({ ...previous, [request.number]: decision === 'approved' ? 'Принятие: решение отправлено.' : 'Отклонение: решение отправлено.' }))
        } catch (reviewError) {
            if (current === session.current) setError(reviewError instanceof Error ? reviewError.message : String(reviewError))
        } finally {
            if (current === session.current) {
                submitting.current = false
                setBusy(0)
            }
        }
    }

    if (!admin) return null

    return (
        <div className="uc-stack">
            <section className="uc-card">
                <div className="uc-section-head">
                    <div>
                        <div className="uc-eyebrow">Владелец: {viewer}</div>
                        <div className="uc-section-title">Заявки на проверку</div>
                    </div>
                    <button type="button" className="uc-btn uc-btn-small" disabled={loading || !!busy} onClick={() => setRefresh(value => value + 1)}>
                        {loading ? 'Загружаем…' : 'Обновить'}
                    </button>
                </div>
                <div className="uc-hint">
                    Прослушайте источник по ссылке в комментарии бота на GitHub перед принятием.
                    Решение ставит метку и передаёт обработку GitHub workflow; это ещё не подтверждение публикации.
                    Итог и доступные записи появятся в заявке на GitHub.
                </div>
                <div className="uc-row-actions uc-wrap">
                    <a className="uc-link" href={issuesUrl} target="_blank" rel="noreferrer">Открыть заявки в GitHub</a>
                </div>
                <div className="uc-muted uc-small uc-mt">
                    Для решений из аддона нужен Issues: Read and write у токена владельца.
                    Иначе поставьте uncensor-approved или uncensor-rejected на сайте GitHub.
                </div>
                {error ? <div className="uc-inline-error" role="alert">{error} Проверьте заявку или отправьте решение на GitHub по ссылкам.</div> : null}
                {!loading && !error && !requests.length ? <div className="uc-muted uc-mt">Новых заявок нет.</div> : null}
            </section>
            {requests.map(request => {
                return (
                    <section className="uc-card" key={request.number}>
                        <div className="uc-section-title">{request.title}</div>
                        <div className="uc-muted uc-small">#{request.number} · Автор: {request.requester}</div>
                        <div className="uc-row-actions uc-wrap uc-mt">
                            <a className="uc-link" href={request.url} target="_blank" rel="noreferrer">Открыть и прослушать в GitHub</a>
                        </div>
                        {sent[request.number] ? (
                            <div className="uc-check uc-ok-text" role="status">{sent[request.number]} Ожидаем GitHub workflow; итог проверяйте в GitHub.</div>
                        ) : (
                            <div className="uc-row-actions uc-wrap uc-mt">
                                <button type="button" className="uc-btn uc-btn-primary uc-btn-small" disabled={!!busy || loading} onClick={() => void decide(request, 'approved')}>Принять</button>
                                <button type="button" className="uc-btn uc-btn-small uc-danger" disabled={!!busy || loading} onClick={() => void decide(request, 'rejected')}>Отклонить</button>
                                {busy === request.number ? <span className="uc-muted uc-small" role="status">Отправляем решение…</span> : null}
                            </div>
                        )}
                    </section>
                )
            })}
        </div>
    )
}
