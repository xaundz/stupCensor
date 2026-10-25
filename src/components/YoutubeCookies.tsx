import { useEffect, useRef, useState } from 'react'

import { getState, isRepositoryAdmin, saveYoutubeCookies, saveYoutubeProxy, startAuthCheck, subscribe } from '../store.ts'
import { useStore } from './useStore.ts'

const LOGIN_URL = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F'
const CHROME_COOKIES_URL = 'https://chromewebstore.google.com/search/get%20cookies.txt%20locally'
const FIREFOX_COOKIES_URL = 'https://addons.mozilla.org/firefox/search/?q=get%20cookies.txt%20locally'

type Action = 'save' | 'save-text' | 'check' | 'proxy'

export function YoutubeCookies() {
    const state = useStore()
    const [file, setFile] = useState<File | null>(null)
    const [cookieText, setCookieText] = useState('')
    const [proxy, setProxy] = useState('')
    const [showProxy, setShowProxy] = useState(false)
    const [busy, setBusy] = useState<Action | ''>('')
    const [message, setMessage] = useState('')
    const [error, setError] = useState('')
    const [checkError, setCheckError] = useState('')
    const [proxyMessage, setProxyMessage] = useState('')
    const [proxyError, setProxyError] = useState('')
    const [savedAt, setSavedAt] = useState(0)
    const input = useRef<HTMLInputElement>(null)
    const revision = useRef(0)
    const working = useRef(false)
    const config = state.config
    const viewer = state.repoInfo?.viewer
    const admin = isRepositoryAdmin()
    const hasUnsavedCookies = Boolean(file || cookieText.trim())

    useEffect(() => {
        const unsubscribe = subscribe(() => {
            const current = getState()
            if (current.config !== config || current.repoInfo?.viewer !== viewer || !isRepositoryAdmin()) {
                revision.current++
                setFile(null)
                setCookieText('')
                setProxy('')
                setBusy('')
                if (input.current) input.current.value = ''
                setMessage('')
                setError('')
                setCheckError('')
                setProxyMessage('')
                setProxyError('')
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
    const currentCheck = !hasUnsavedCookies && latestCheck && Date.parse(latestCheck.createdAt) >= savedAt ? latestCheck : undefined

    const clearSelectedCookies = () => {
        setFile(null)
        setCookieText('')
        if (input.current) input.current.value = ''
        setError('')
        setCheckError('')
    }

    const run = async (action: Action) => {
        if (working.current || !isRepositoryAdmin()) return
        if (action === 'save' && !file) return
        if (action === 'save-text' && !cookieText.trim()) return
        if (action === 'proxy' && !proxy.trim()) return
        if (action === 'check' && hasUnsavedCookies) return
        const current = revision.current
        const inScope = () => current === revision.current && getState().config === config &&
            getState().repoInfo?.viewer === viewer && isRepositoryAdmin()
        working.current = true
        setBusy(action)
        if (action === 'save' || action === 'save-text') {
            setError('')
            setCheckError('')
            setMessage('')
        } else if (action === 'proxy') {
            setProxyMessage('')
            setProxyError('')
        } else {
            setCheckError('')
        }
        try {
            if (action === 'save') {
                await saveYoutubeCookies(file!)
            } else if (action === 'save-text') {
                await saveYoutubeCookies(new File([cookieText], 'cookies.txt', { type: 'text/plain' }))
            } else if (action === 'proxy') {
                await saveYoutubeProxy(proxy)
            } else {
                await startAuthCheck()
            }
            if (!inScope()) return
            if (action === 'save' || action === 'save-text') {
                setFile(null)
                setCookieText('')
                setSavedAt(Date.now())
                if (input.current) input.current.value = ''
                setMessage('Cookies сохранены в секрете GitHub YTDLP_COOKIES. Проверьте доступ к YouTube кнопкой ниже.')
            } else if (action === 'proxy') {
                setProxy('')
                setSavedAt(Date.now())
                setCheckError('')
                setProxyMessage('Прокси сохранён в секрете GitHub YTDLP_PROXY. Проверьте доступ к YouTube кнопкой выше.')
            }
        } catch (operationError) {
            if (!inScope()) return
            const text = operationError instanceof Error ? operationError.message : 'Не удалось выполнить действие. Попробуйте ещё раз.'
            if (action === 'proxy') setProxyError(text)
            else if (action === 'check') setCheckError(`Не удалось запустить проверку: ${text}`)
            else setError(text)
        } finally {
            working.current = false
            if (inScope()) setBusy('')
        }
    }

    if (!admin || !config) return null

    return (
        <section className="uc-card">
            <div className="uc-eyebrow">Источники</div>
            <div className="uc-section-title">YouTube: cookies и прокси</div>
            <div className="uc-hint">
                YouTube может требовать вход с серверов GitHub Actions. Войти можно в обычном браузере,
                но cookies нужно экспортировать отдельно: аддон работает в sandbox и не читает cookies браузера.
                Вход через Google OAuth не передаёт сессию вашему GitHub runner.
            </div>
            <ol className="uc-steps">
                <li>
                    <a className="uc-btn uc-btn-small" href={LOGIN_URL} target="_blank" rel="noreferrer">Войти в YouTube</a>
                    {' '}в обычном внешнем браузере. Аддон не открывает форму пароля и не получает доступ к аккаунту.
                </li>
                <li>
                    Установить «Get cookies.txt LOCALLY» и экспортировать cookies для <code>youtube.com</code> в файл
                    {' '}<code>cookies.txt</code> формата Netscape:
                    {' '}<a className="uc-link" href={CHROME_COOKIES_URL} target="_blank" rel="noreferrer">Chrome</a>
                    {' · '}
                    <a className="uc-link" href={FIREFOX_COOKIES_URL} target="_blank" rel="noreferrer">Firefox</a>.
                    <details className="uc-details uc-small">
                        <summary>Почему нельзя войти прямо в аддоне?</summary>
                        <div className="uc-details-body">
                            PulseSync-аддон не имеет доступа к cookies браузера или Electron-сессии.
                            Автоматически забрать cookies после входа невозможно, поэтому нужен экспорт.
                            Проверяйте название и разрешения расширения, не вводите пароль Google в аддоне.
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
                                setCookieText('')
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
            <details className="uc-details uc-small">
                <summary>Или вставить cookies текстом</summary>
                <div className="uc-details-body">
                    <div className="uc-hint">
                        Если расширение умеет копировать cookies, вставьте содержимое <code>cookies.txt</code> сюда.
                        Формат тот же: Netscape, только youtube.com.
                    </div>
                    <label className="uc-field">
                        <span>Содержимое cookies.txt</span>
                        <textarea
                            value={cookieText}
                            onChange={event => {
                                setCookieText(event.target.value)
                                setMessage('')
                                setError('')
                                if (file) {
                                    setFile(null)
                                    if (input.current) input.current.value = ''
                                }
                            }}
                            placeholder={'# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t...\tSID\t...'}
                            spellCheck={false}
                            autoComplete="off"
                        />
                    </label>
                    <div className="uc-row-actions uc-wrap uc-mt">
                        <button
                            type="button"
                            className="uc-btn uc-btn-primary"
                            disabled={!cookieText.trim() || Boolean(busy) || pending || !admin}
                            onClick={() => void run('save-text')}
                        >
                            {busy === 'save-text' ? 'Сохраняем…' : 'Сохранить вставленные cookies'}
                        </button>
                    </div>
                </div>
            </details>
            <div className="uc-row-actions uc-wrap">
                <button type="button" className="uc-btn uc-btn-primary" disabled={!file || Boolean(busy) || pending || !admin} onClick={() => void run('save')}>
                    {busy === 'save' ? 'Загружаем…' : 'Загрузить cookies в GitHub'}
                </button>
                <button type="button" className="uc-btn uc-btn-small" disabled={hasUnsavedCookies || Boolean(busy) || pending || !admin} onClick={() => void run('check')}>
                    {busy === 'check' ? 'Запускаем…' : pending ? 'Проверка выполняется…' : 'Проверить YouTube'}
                </button>
                {hasUnsavedCookies ? (
                    <button type="button" className="uc-btn uc-btn-small" disabled={Boolean(busy)} title="Секрет в GitHub не удаляется" onClick={clearSelectedCookies}>
                        Очистить
                    </button>
                ) : null}
            </div>
            {hasUnsavedCookies ? <div className="uc-hint">Cookies ещё не сохранены. Проверка использует секрет GitHub, а не выбранный файл или текст: сначала сохраните их. После ручного обновления секрета на сайте нажмите «Проверить YouTube».</div> : null}
            <div aria-live="polite">
                {message ? <div className="uc-check uc-ok-text">{message}</div> : null}
                {error ? (
                    <div className="uc-inline-error" role="alert">
                        {error}
                        <div className="uc-row-actions uc-wrap uc-mt">
                            <a className="uc-btn uc-btn-small" href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noreferrer">Изменить права токена</a>
                            <a className="uc-btn uc-btn-small" href={`https://github.com/${config.repo}/settings/secrets/actions`} target="_blank" rel="noreferrer">Добавить cookies без изменения токена</a>
                        </div>
                    </div>
                ) : null}
                {checkError ? <div className="uc-inline-error">{checkError}</div> : null}
                {pending ? <div className="uc-hint">Проверка YouTube выполняется. Результат появится здесь и в «Заданиях».</div> : null}
                {currentCheck?.status === 'ready' ? <div className="uc-check uc-ok-text">Результат последней проверки: {currentCheck.note || 'Проверка завершена.'}</div> : null}
                {currentCheck?.status === 'failed' ? <div className="uc-inline-error">Последняя проверка: {currentCheck.error?.message || 'Не удалось проверить YouTube. Откройте «Задания».'}</div> : null}
                {currentCheck?.status === 'abandoned' ? <div className="uc-hint">Последняя проверка остановлена. Можно запустить её снова.</div> : null}
            </div>

            <div className="uc-divider" />

            <div className="uc-eyebrow">Если YouTube блокирует IP</div>
            <div className="uc-section-title">Прокси для загрузки</div>
            <div className="uc-hint">
                Прокси нужен, если cookies не помогают и YouTube пишет «Sign in to confirm you’re not a bot».
                Подойдёт HTTP, HTTPS или SOCKS5-прокси с доступом из интернета. Адрес хранится только в секрете
                {' '}<code>YTDLP_PROXY</code> и передаётся worker’у GitHub Actions.
            </div>
            <label className="uc-field">
                <span>Адрес прокси</span>
                <div className="uc-inline">
                    <input
                        className="uc-grow"
                        type={showProxy ? 'text' : 'password'}
                        value={proxy}
                        onChange={event => {
                            setProxy(event.target.value)
                            setProxyMessage('')
                            setProxyError('')
                        }}
                        placeholder="http://user:pass@host:8080"
                        autoComplete="off"
                        spellCheck={false}
                        autoCapitalize="off"
                    />
                    <button type="button" className="uc-btn uc-btn-small" onClick={() => setShowProxy(value => !value)}>
                        {showProxy ? 'Скрыть' : 'Показать'}
                    </button>
                </div>
            </label>
            <div className="uc-row-actions uc-wrap">
                <button
                    type="button"
                    className="uc-btn uc-btn-primary"
                    disabled={!proxy.trim() || Boolean(busy) || pending || !admin}
                    onClick={() => void run('proxy')}
                >
                    {busy === 'proxy' ? 'Сохраняем…' : 'Сохранить прокси в GitHub'}
                </button>
            </div>
            <div aria-live="polite">
                {proxyMessage ? <div className="uc-check uc-ok-text">{proxyMessage}</div> : null}
                {proxyError ? (
                    <div className="uc-inline-error" role="alert">
                        {proxyError}
                        <div className="uc-row-actions uc-wrap uc-mt">
                            <a className="uc-btn uc-btn-small" href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noreferrer">Изменить права токена</a>
                            <a className="uc-btn uc-btn-small" href={`https://github.com/${config.repo}/settings/secrets/actions`} target="_blank" rel="noreferrer">Добавить YTDLP_PROXY на сайте</a>
                        </div>
                    </div>
                ) : null}
            </div>
            <div className="uc-muted uc-small uc-mt">
                Не используйте локальный адрес: GitHub Actions не сможет к нему подключиться. URL может содержать
                логин и пароль прокси, поэтому аддон маскирует ввод, шифрует значение и не сохраняет его локально.
                Прокси не гарантирует обход блокировки: YouTube может отклонить и прокси-IP.
            </div>

            <div className="uc-hint uc-mt">
                Для загрузки cookies и прокси из аддона один раз откройте{' '}
                <a className="uc-link" href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noreferrer">настройки токена</a>
                {' '}→ выберите используемый токен → Repository permissions → Secrets → Read and write → Save.
                Репозиторий <code>{config.repo}</code> должен быть выбран в доступе токена. Права Actions и Contents не заменяют Secrets.
                Если не хочешь менять права, добавь значения через сайт GitHub.
            </div>
            <details className="uc-details uc-small">
                <summary>Добавить через сайт GitHub</summary>
                <div className="uc-details-body">
                    Откройте <a className="uc-link" href={`https://github.com/${config.repo}/settings/secrets/actions/new`} target="_blank" rel="noreferrer">новый секрет Actions</a>.
                    Для cookies укажите имя <code>YTDLP_COOKIES</code> и вставьте содержимое cookies.txt.
                    Для прокси укажите имя <code>YTDLP_PROXY</code> и полный адрес с логином и паролем, если они нужны.
                    Если секрет уже есть, обновите его в настройках Secrets and variables → Actions.
                    Не загружайте файл или пароль в код репозитория или Issue.
                </div>
            </details>
            <div className="uc-muted uc-small uc-mt">
                Cookies дают доступ к сессии аккаунта Google. Используйте отдельный аккаунт, не делитесь файлом
                и не публикуйте его. Аддон читает cookies в памяти только при загрузке, шифрует их для секрета GitHub
                и не сохраняет содержимое локально. Проверка читает тестовое видео без скачивания;
                сохранение cookies или прокси не гарантирует, что YouTube разрешит доступ с IP GitHub Actions.
            </div>
        </section>
    )
}
