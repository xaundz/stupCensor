import { useEffect, useState } from 'react'

import { settings } from '../legacy/settings.ts'
import { disconnectGitHub, saveSetup } from '../store.ts'
import { useStore } from './useStore.ts'

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new'

export function SettingsTab() {
    const state = useStore()
    const preferences = settings.use()
    const [repo, setRepo] = useState(state.config?.repo || '')
    const [token, setToken] = useState('')
    const [remember, setRemember] = useState(state.config?.rememberToken !== false)
    const [showToken, setShowToken] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    const [success, setSuccess] = useState('')
    const [disconnect, setDisconnect] = useState<'token' | 'repo' | ''>('')

    useEffect(() => {
        if (state.config?.repo) setRepo(state.config.repo)
    }, [state.config?.repo])

    const submit = async () => {
        setError('')
        setSuccess('')
        setSaving(true)
        try {
            const result = await saveSetup({ repo, token, rememberToken: remember })
            setToken('')
            setSuccess(`Подключено: ${result.repo.fullName}. Workflow активен.`)
        } catch (submitError) {
            setError(submitError instanceof Error ? submitError.message : String(submitError))
        } finally {
            setSaving(false)
        }
    }

    const remove = async () => {
        setSaving(true)
        setError('')
        try {
            await disconnectGitHub(disconnect === 'repo')
            setDisconnect('')
            setSuccess(disconnect === 'repo' ? 'Репозиторий отключён.' : 'Токен удалён, остался режим чтения.')
        } catch (removeError) {
            setError(removeError instanceof Error ? removeError.message : String(removeError))
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="uc-stack">
            <section className="uc-card">
                <div className="uc-section-head">
                    <div>
                        <div className="uc-eyebrow">Подключение</div>
                        <div className="uc-section-title">Ваш GitHub</div>
                    </div>
                    <span className={`uc-status-pill ${state.config ? 'uc-ok' : ''}`}>
                        {state.config ? (state.hasToken ? 'Подключён' : 'Только чтение') : 'Не подключён'}
                    </span>
                </div>
                <div className="uc-hint">
                    Нужен публичный репозиторий: Яндекс Музыке требуются прямые ссылки без авторизации. Токен даёт
                    доступ только к Actions и Contents выбранного репозитория.
                </div>
                <div className="uc-grid uc-grid-1">
                    <label className="uc-field">
                        <span>Репозиторий</span>
                        <input
                            value={repo}
                            onChange={event => setRepo(event.target.value)}
                            placeholder="владелец/репозиторий"
                            autoComplete="off"
                        />
                    </label>
                    <label className="uc-field">
                        <span>Fine-grained token {state.hasToken && !token ? '(уже сохранён)' : ''}</span>
                        <div className="uc-inline">
                            <input
                                className="uc-grow"
                                type={showToken ? 'text' : 'password'}
                                value={token}
                                onChange={event => setToken(event.target.value)}
                                placeholder={state.hasToken ? 'Оставьте пустым, чтобы использовать сохранённый' : 'github_pat_…'}
                                autoComplete="off"
                                spellCheck={false}
                            />
                            <button type="button" className="uc-btn uc-btn-small" onClick={() => setShowToken(value => !value)}>
                                {showToken ? 'Скрыть' : 'Показать'}
                            </button>
                        </div>
                    </label>
                    <label className="uc-checkbox">
                        <input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />
                        <span>
                            Хранить токен в локальном хранилище PulseSync
                            <span className="uc-muted uc-small"> Без токена останется режим чтения.</span>
                        </span>
                    </label>
                </div>
                <div className="uc-row-actions uc-wrap">
                    <button type="button" className="uc-btn uc-btn-primary" disabled={saving || !repo.trim()} onClick={() => void submit()}>
                        {saving ? 'Проверяем…' : state.config ? 'Сохранить' : 'Подключить'}
                    </button>
                    <a className="uc-link uc-small" href={TOKEN_URL} target="_blank" rel="noreferrer">
                        Создать токен
                    </a>
                </div>
                {error ? <div className="uc-inline-error">{error}</div> : null}
                {success ? <div className="uc-check uc-ok-text">{success}</div> : null}
                <div className="uc-muted uc-small uc-mt">Токен не попадает в репозиторий и не передаётся в workflow.</div>
            </section>

            {state.config ? (
                <section className="uc-card">
                    <div className="uc-section-head">
                        <div>
                            <div className="uc-eyebrow">Состояние</div>
                            <div className="uc-section-title">Доступ</div>
                        </div>
                        {state.workflow?.htmlUrl ? (
                            <a className="uc-link uc-small" href={state.workflow.htmlUrl} target="_blank" rel="noreferrer">
                                Actions
                            </a>
                        ) : null}
                    </div>
                    <div className="uc-kv">
                        <div><span>Репозиторий</span><strong>{state.config.repo}</strong></div>
                        <div><span>Ветка</span><strong>{state.config.branch}</strong></div>
                        <div><span>Видимость</span><strong>{state.repoInfo?.private ? 'приватный — не подходит' : 'публичный'}</strong></div>
                        <div><span>Запись</span><strong>{state.repoInfo?.canPush === undefined ? 'не проверялась' : state.repoInfo.canPush ? 'есть' : 'только чтение'}</strong></div>
                        <div><span>Workflow</span><strong>{state.workflow ? state.workflow.state : 'проверен при подключении'}</strong></div>
                    </div>
                    <div className="uc-row-actions uc-wrap">
                        {disconnect === 'repo' || disconnect === 'token' ? (
                            <>
                                <button type="button" className="uc-btn uc-btn-small uc-danger" disabled={saving} onClick={() => void remove()}>
                                    {disconnect === 'repo' ? 'Отключить репозиторий' : 'Удалить токен'}
                                </button>
                                <button type="button" className="uc-btn uc-btn-small" onClick={() => setDisconnect('')}>Отмена</button>
                            </>
                        ) : (
                            <>
                                {state.hasToken ? (
                                    <button type="button" className="uc-btn uc-btn-small" onClick={() => setDisconnect('token')}>
                                        Удалить токен
                                    </button>
                                ) : null}
                                <button type="button" className="uc-btn uc-btn-small" onClick={() => setDisconnect('repo')}>
                                    Отключить репозиторий
                                </button>
                            </>
                        )}
                    </div>
                </section>
            ) : null}

            <section className="uc-card">
                <div className="uc-eyebrow">Поведение</div>
                <div className="uc-section-title">Аддон</div>
                <label className="uc-checkbox uc-checkbox-spaced">
                    <input
                        type="checkbox"
                        checked={preferences.autoApply}
                        onChange={event => settings.set({ autoApply: event.target.checked })}
                    />
                    <span>Применять библиотеку при запуске и обновлении</span>
                </label>
                <div className="uc-muted uc-small uc-mt">
                    Меню трека: «Найти без цензуры» и «stupidCensor: открыть».
                </div>
            </section>

            <details className="uc-card uc-details">
                <summary>Подготовка репозитория</summary>
                <div className="uc-details-body">
                    <ol className="uc-steps">
                        <li><code>list.json</code> в корне ветки.</li>
                        <li><code>.github/workflows/uncensor-cloud.yml</code>.</li>
                        <li><code>cloud/uncensor_worker.py</code> и <code>requirements.txt</code>.</li>
                        <li>Actions: <strong>Read and write permissions</strong>.</li>
                    </ol>
                    <div className="uc-hint">
                        Fine-grained token: Contents — Read and write, Actions — Read and write, Metadata — Read.
                    </div>
                    <div className="uc-muted uc-small">
                        Публикуйте только записи, на которые у вас есть права. Репозиторий и аудиофайлы видны всем.
                    </div>
                </div>
            </details>
        </div>
    )
}
