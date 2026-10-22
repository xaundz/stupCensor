import { useEffect, useState } from 'react'

import { settings } from '../legacy/settings.ts'
import { disconnectGitHub, saveSetup } from '../store.ts'
import { useStore } from './useStore.ts'

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new'
const TOKENS_URL = 'https://github.com/settings/tokens'

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
            setSuccess(`Подключено: ${result.repo.fullName}. Workflow «${result.workflow.name}» активен.`)
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
            setSuccess(disconnect === 'repo' ? 'Репозиторий отключён.' : 'Токен удалён, библиотека осталась в режиме чтения.')
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
                        <div className="uc-eyebrow">Мой GitHub</div>
                        <div className="uc-section-title">Ваш публичный репозиторий</div>
                    </div>
                    <span className={`uc-status-pill ${state.config ? 'uc-ok' : ''}`}>
                        {state.config ? (state.hasToken ? 'Подключён' : 'Только чтение') : 'Не подключён'}
                    </span>
                </div>
                <div className="uc-hint">
                    Аддон хранит аудио и публичный индекс в вашем GitHub-репозитории. Репозиторий должен быть публичным:
                    Яндекс Музыке нужны прямые ссылки на файлы без авторизации. Токен даёт доступ к Actions и Contents.
                </div>
                <div className="uc-grid uc-grid-1">
                    <label className="uc-field">
                        <span>Репозиторий</span>
                        <input
                            value={repo}
                            onChange={event => setRepo(event.target.value)}
                            placeholder="владелец/репозиторий или https://github.com/владелец/репозиторий"
                            autoComplete="off"
                        />
                    </label>
                    <label className="uc-field">
                        <span>Fine-grained token {state.hasToken && !token ? '(уже сохранён, оставьте пустым)' : ''}</span>
                        <div className="uc-inline">
                            <input
                                className="uc-grow"
                                type={showToken ? 'text' : 'password'}
                                value={token}
                                onChange={event => setToken(event.target.value)}
                                placeholder={state.hasToken ? 'Токен сохранён' : 'github_pat_…'}
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
                            Хранить токен в локальном хранилище аддона
                            <span className="uc-muted uc-small"> Если выключить, после перезапуска останется режим чтения и поиск не запустится.</span>
                        </span>
                    </label>
                </div>
                <div className="uc-row-actions uc-wrap">
                    <button type="button" className="uc-btn uc-btn-primary" disabled={saving || !repo.trim()} onClick={() => void submit()}>
                        {saving ? 'Проверяем…' : state.config ? 'Проверить и сохранить' : 'Подключить'}
                    </button>
                    <a className="uc-btn uc-btn-small" href={TOKEN_URL} target="_blank" rel="noreferrer">
                        Создать fine-grained token
                    </a>
                </div>
                {error ? <div className="uc-inline-error">{error}</div> : null}
                {success ? <div className="uc-check uc-ok-text">{success}</div> : null}
                <div className="uc-muted uc-small">
                    Токен передаётся только на api.github.com. Не вставляйте его в text-ссылки, index или workflow inputs.
                </div>
            </section>

            <section className="uc-card">
                <div className="uc-eyebrow">Состояние подключения</div>
                <div className="uc-section-title">Проверка доступа</div>
                {state.config ? (
                    <div className="uc-kv">
                        <div><span>Репозиторий</span><strong>{state.config.repo}</strong></div>
                        <div><span>Ветка</span><strong>{state.config.branch}</strong></div>
                        <div><span>Публичность</span><strong>{state.repoInfo ? (state.repoInfo.private ? 'приватный — не подходит' : 'публичный') : 'проверено при подключении'}</strong></div>
                        <div><span>Права на запись</span><strong>{state.repoInfo?.canPush === undefined ? 'не проверялись' : state.repoInfo.canPush ? 'есть' : 'нет / токен только на чтение'}</strong></div>
                        <div>
                            <span>Workflow</span>
                            <strong>
                                {state.workflow ? `${state.workflow.name} · ${state.workflow.state}` : 'не проверялся в этой сессии'}
                            </strong>
                        </div>
                        <div><span>Токен</span><strong>{state.hasToken ? 'сохранён' : 'не сохранён (режим чтения)'}</strong></div>
                    </div>
                ) : (
                    <div className="uc-muted">Подключите репозиторий, чтобы читать list.json и запускать поиск.</div>
                )}
                {state.workflow?.htmlUrl ? (
                    <a className="uc-link" href={state.workflow.htmlUrl} target="_blank" rel="noreferrer">
                        Открыть workflow в GitHub
                    </a>
                ) : null}
                {state.config ? (
                    <div className="uc-row-actions uc-wrap">
                        {disconnect === 'repo' ? (
                            <>
                                <button type="button" className="uc-btn uc-btn-small uc-danger" disabled={saving} onClick={() => void remove()}>
                                    Да, отключить репозиторий
                                </button>
                                <button type="button" className="uc-btn uc-btn-small" onClick={() => setDisconnect('')}>Отмена</button>
                            </>
                        ) : disconnect === 'token' ? (
                            <>
                                <button type="button" className="uc-btn uc-btn-small uc-danger" disabled={saving} onClick={() => void remove()}>
                                    Да, удалить токен
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
                ) : null}
            </section>

            <section className="uc-card">
                <div className="uc-eyebrow">stupidCensor</div>
                <div className="uc-section-title">Поведение аддона</div>
                <div className="uc-stack uc-stack-tight">
                    <label className="uc-checkbox">
                        <input
                            type="checkbox"
                            checked={preferences.autoApply}
                            onChange={event => settings.set({ autoApply: event.target.checked })}
                        />
                        <span>Автоматически применять библиотеку при запуске и обновлении</span>
                    </label>
                    <label className="uc-checkbox">
                        <input
                            type="checkbox"
                            checked={preferences.pauseOnPreview}
                            onChange={event => settings.set({ pauseOnPreview: event.target.checked })}
                        />
                        <span>Ставить Яндекс Музыку на паузу при прослушивании кандидата</span>
                    </label>
                    <label className="uc-checkbox">
                        <input
                            type="checkbox"
                            checked={preferences.autoResume}
                            onChange={event => settings.set({ autoResume: event.target.checked })}
                        />
                        <span>Возобновлять музыку после предпросмотра, если паузу поставил аддон</span>
                    </label>
                </div>
                <div className="uc-hint">Панель открывается из меню трека (три точки) → «stupidCensor: открыть».</div>
            </section>

            <section className="uc-card">
                <div className="uc-eyebrow">Что должно быть в репозитории</div>
                <div className="uc-section-title">Файлы облака</div>
                <ol className="uc-steps">
                    <li><code>list.json</code> в корне ветки — публичный индекс замен.</li>
                    <li><code>.github/workflows/uncensor-cloud.yml</code> — поиск и публикация через workflow_dispatch.</li>
                    <li><code>cloud/uncensor_worker.py</code> и <code>cloud/requirements.txt</code> — обработчик заданий.</li>
                    <li>Релизы <code>previews</code> и <code>library</code> — предпросмотры и постоянные аудиофайлы.</li>
                </ol>
                <div className="uc-hint">
                    Fine-grained token: Contents — Read and write, Actions — Read and write, Metadata — Read. Для классического
                    token нужны права <code>repo</code> и <code>workflow</code>.
                </div>
                <a className="uc-link uc-small" href={TOKENS_URL} target="_blank" rel="noreferrer">
                    Управление классическими токенами
                </a>
            </section>
        </div>
    )
}
