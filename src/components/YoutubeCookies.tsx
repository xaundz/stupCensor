import { useEffect, useRef, useState } from 'react'

import { getState, isRepositoryAdmin, saveYoutubeCookies, startAuthCheck, subscribe } from '../store.ts'
import { useStore } from './useStore.ts'

export function YoutubeCookies() {
    const state = useStore()
    const [file, setFile] = useState<File | null>(null)
    const [busy, setBusy] = useState<'save' | 'check' | ''>('')
    const [message, setMessage] = useState('')
    const [error, setError] = useState('')
    const [checkError, setCheckError] = useState('')
    const [savedAt, setSavedAt] = useState(0)
    const input = useRef<HTMLInputElement>(null)
    const revision = useRef(0)
    const working = useRef(false)
    const config = state.config
    const viewer = state.repoInfo?.viewer
    const admin = isRepositoryAdmin()

    useEffect(() => {
        const unsubscribe = subscribe(() => {
            const current = getState()
            if (current.config !== config || current.repoInfo?.viewer !== viewer || !isRepositoryAdmin()) {
                revision.current++
                setFile(null)
                if (input.current) input.current.value = ''
                setMessage('')
                setError('')
                setCheckError('')
                setSavedAt(0)
            }
        })
        const element = input.current
        return () => {
            unsubscribe()
            revision.current++
            if (element) element.value = ''
        }
    }, [config, viewer])

    const latestCheck = state.jobs
        .filter(job => job.action === 'check' && job.repo === config?.repo && job.branch === config?.branch)
        .reduce<(typeof state.jobs)[number] | undefined>((latest, job) =>
            !latest || job.createdAt > latest.createdAt ? job : latest, undefined)
    const pending = latestCheck?.status === 'queued' || latestCheck?.status === 'running'
    const currentCheck = latestCheck && Date.parse(latestCheck.createdAt) >= savedAt ? latestCheck : undefined

    const run = async (action: 'save' | 'check') => {
        if (working.current || !isRepositoryAdmin() || (action === 'save' && !file)) return
        const current = revision.current
        const inScope = () => current === revision.current && getState().config === config &&
            getState().repoInfo?.viewer === viewer && isRepositoryAdmin()
        working.current = true
        setBusy(action)
        if (action === 'save') {
            setError('')
            setMessage('')
        } else setCheckError('')
        try {
            if (action === 'save') {
                await saveYoutubeCookies(file!)
                if (!inScope()) return
                setFile(null)
                setSavedAt(Date.now())
                if (input.current) input.current.value = ''
                setMessage('Cookies сохранены в секрете GitHub YTDLP_COOKIES. Это ещё не подтверждает доступ к YouTube. Запустите проверку ниже.')
            } else {
                await startAuthCheck()
            }
        } catch (operationError) {
            if (!inScope()) return
            const text = operationError instanceof Error ? operationError.message : 'Не удалось выполнить действие. Попробуйте ещё раз.'
            if (action === 'save') setError(text)
            else setCheckError(`Не удалось запустить проверку: ${text}`)
        } finally {
            working.current = false
            if (inScope()) setBusy('')
        }
    }

    if (!admin || !config) return null

    return (
        <section className="uc-card">
            <div className="uc-eyebrow">Источники</div>
            <div className="uc-section-title">YouTube cookies</div>
            <div className="uc-hint">
                YouTube может требовать вход с серверов GitHub Actions. Вход через Google OAuth сам по себе
                не передаёт cookies вашему GitHub runner: для него нужно отдельно загрузить файл сессии YouTube.
            </div>
            <ol className="uc-steps">
                <li>
                    <a className="uc-link" href="https://www.youtube.com/" target="_blank" rel="noreferrer">Открыть YouTube</a>
                    {' '}в обычном внешнем браузере и войти в Google-аккаунт, который будет использоваться для проверки.
                </li>
                <li>
                    Экспортировать cookies для <code>youtube.com</code> в файл <code>cookies.txt</code> формата Netscape.
                    <details className="uc-details uc-small">
                        <summary>Как экспортировать cookies</summary>
                        <div className="uc-details-body">
                            Используйте проверенное расширение «Get cookies.txt LOCALLY» из официального магазина браузера.
                            Проверьте название и разрешения, не устанавливайте случайные аналоги.
                            На открытой странице YouTube экспортируйте cookies только для youtube.com в формате Netscape,
                            а не для всех сайтов. Сохраните файл локально.
                        </div>
                    </details>
                </li>
                <li>
                    <label className="uc-field">
                        <span>Выбрать cookies.txt (до 48 КиБ)</span>
                        <input
                            ref={input}
                            type="file"
                            accept=".txt,.cookies,text/plain"
                            disabled={Boolean(busy) || pending || !admin}
                            onChange={event => {
                                const selected = event.target.files?.[0] || null
                                setMessage('')
                                setError('')
                                if (selected && (selected.size === 0 || selected.size > 48 * 1024)) {
                                    setFile(null)
                                    event.target.value = ''
                                    setError(selected.size === 0 ? 'Файл пуст. Экспортируйте cookies ещё раз.' : 'Файл больше 48 КиБ. Экспортируйте cookies только для youtube.com.')
                                    return
                                }
                                setFile(selected)
                            }}
                        />
                    </label>
                </li>
            </ol>
            <div className="uc-row-actions uc-wrap">
                <button type="button" className="uc-btn uc-btn-primary" disabled={!file || Boolean(busy) || pending || !admin} onClick={() => void run('save')}>
                    {busy === 'save' ? 'Загружаем…' : 'Загрузить cookies в GitHub'}
                </button>
                <button type="button" className="uc-btn uc-btn-small" disabled={Boolean(busy) || pending || !admin} onClick={() => void run('check')}>
                    {busy === 'check' ? 'Запускаем…' : pending ? 'Проверка выполняется…' : 'Проверить YouTube'}
                </button>
            </div>
            <div aria-live="polite">
                {message ? <div className="uc-check uc-ok-text">{message}</div> : null}
                {error ? <div className="uc-inline-error">{error}</div> : null}
                {checkError ? <div className="uc-inline-error">{checkError}</div> : null}
                {pending ? <div className="uc-hint">Проверка YouTube выполняется. Результат появится здесь и в «Заданиях».</div> : null}
                {currentCheck?.status === 'ready' ? <div className="uc-check uc-ok-text">Результат последней проверки: {currentCheck.note || 'Проверка завершена.'}</div> : null}
                {currentCheck?.status === 'failed' ? <div className="uc-inline-error">Последняя проверка: {currentCheck.error?.message || 'Не удалось проверить YouTube. Откройте «Задания».'}</div> : null}
                {currentCheck?.status === 'abandoned' ? <div className="uc-hint">Последняя проверка остановлена. Можно запустить её снова.</div> : null}
            </div>
            <div className="uc-hint uc-mt">
                Для загрузки из аддона один раз откройте{' '}
                <a className="uc-link" href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noreferrer">настройки токена</a>
                {' '}и добавьте Repository permissions → Secrets: Read and write для этого репозитория.
                Если не хочешь менять права, добавь файл через сайт GitHub.
            </div>
            <details className="uc-details uc-small">
                <summary>Добавить через сайт GitHub</summary>
                <div className="uc-details-body">
                    Откройте <a className="uc-link" href={`https://github.com/${config.repo}/settings/secrets/actions/new`} target="_blank" rel="noreferrer">новый секрет Actions</a>,
                    {' '}укажите имя <code>YTDLP_COOKIES</code> и вставьте содержимое cookies.txt в поле Secret.
                    Если секрет уже есть, обновите его в настройках Secrets and variables → Actions.
                    Не загружайте файл в код репозитория или Issue.
                </div>
            </details>
            <div className="uc-muted uc-small uc-mt">
                Cookies дают доступ к сессии аккаунта Google. Используйте отдельный аккаунт, не делитесь файлом
                и не публикуйте его. Аддон читает файл в памяти только при загрузке, шифрует его для секрета GitHub
                и не сохраняет его содержимое локально. Проверка читает тестовое видео без скачивания;
                сохранение cookies не гарантирует, что YouTube разрешит доступ с IP GitHub Actions.
            </div>
        </section>
    )
}
