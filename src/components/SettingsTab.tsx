import { useEffect, useState } from 'react'

import { SHARED_REPO } from '../legacy/constants.ts'
import { settings } from '../legacy/settings.ts'
import { disconnectGitHub, isRepositoryAdmin, isRepositoryOwner, refreshRepoAccess, saveSetup, setTestAsUser } from '../store.ts'
import { useStore } from './useStore.ts'
import { YoutubeCookies } from './YoutubeCookies.tsx'

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new'

export function SettingsTab() {
    const state = useStore()
    const preferences = settings.use()
    const [repo, setRepo] = useState(state.config?.repo || SHARED_REPO)
    const [token, setToken] = useState('')
    const [remember, setRemember] = useState(state.config?.rememberToken !== false)
    const [showToken, setShowToken] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    const [success, setSuccess] = useState('')
    const [disconnect, setDisconnect] = useState<'token' | 'repo' | ''>('')

    useEffect(() => {
        setRepo(state.config?.repo || SHARED_REPO)
    }, [state.config?.repo])

    useEffect(() => {
        if (!state.hasToken) {
            setToken('')
            setShowToken(false)
            setDisconnect('')
            setSuccess('')
            setError('')
        }
    }, [state.hasToken, state.config?.repo])

    const submit = async () => {
        setError('')
        setSuccess('')
        setSaving(true)
        try {
            const result = await saveSetup({ repo, token, rememberToken: remember })
            setToken('')
            setSuccess(`Подключено: ${result.repo.fullName}. ${isRepositoryAdmin() ? 'Вход владельца выполнен.' : 'Заявки доступны через браузер GitHub без токена.'}`)
        } catch (submitError) {
            setError(submitError instanceof Error ? submitError.message : String(submitError))
        } finally {
            setSaving(false)
        }
    }

    const connectShared = async () => {
        setError('')
        setSuccess('')
        setSaving(true)
        try {
            const result = await saveSetup(
                { repo: SHARED_REPO, token: '', rememberToken: false },
                { readOnly: true },
            )
            setRepo(result.repo.fullName)
            setToken('')
            setSuccess('Общая библиотека подключена в режиме чтения — без токена.')
        } catch (submitError) {
            setError(submitError instanceof Error ? submitError.message : String(submitError))
        } finally {
            setSaving(false)
        }
    }

    const checkAccess = async () => {
        setError('')
        setSuccess('')
        setSaving(true)
        try {
            const info = await refreshRepoAccess()
            setSuccess(
                info?.viewer
                    ? `Аккаунт: ${info.viewer}. ${isRepositoryAdmin() ? 'Права владельца.' : 'Заявки без доступа к репозиторию.'}`
                    : info ? 'Общая библиотека. Заявки без доступа к репозиторию.' : 'Не удалось проверить доступ. Попробуйте ещё раз.',
            )
        } catch (checkError) {
            setError(checkError instanceof Error ? checkError.message : String(checkError))
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

    const admin = isRepositoryAdmin()
    const accessLabel = !state.config
        ? 'Не подключён'
        : admin
          ? 'Владелец'
           : 'Заявки без доступа к репозиторию'

    return (
        <div className="uc-stack">
            {isRepositoryOwner() ? (
                <section className="uc-card">
                    <div className="uc-eyebrow">Только владельцу</div>
                    <div className="uc-section-title">Проверка пользовательского режима</div>
                    <label className="uc-checkbox uc-checkbox-spaced">
                        <input type="checkbox" checked={state.testAsUser} onChange={event => setTestAsUser(event.target.checked)} />
                        <span>Тестировать как обычный пользователь</span>
                    </label>
                    <div className="uc-hint">
                        Аккаунт остаётся подключён. В аддоне доступны только пользовательские действия и заявки,
                        без публикации и удаления из GitHub. После перезапуска режим выключится.
                        На самом сайте GitHub вы по-прежнему владелец.
                    </div>
                </section>
            ) : null}
            <section className="uc-card">
                <div className="uc-section-head">
                    <div>
                        <div className="uc-eyebrow">Для друзей</div>
                        <div className="uc-section-title">Общая библиотека</div>
                    </div>
                    <span className="uc-status-pill uc-ok">Без токена</span>
                </div>
                <div className="uc-hint">
                    Замены доступны без токена и доступа к репозиторию. Скрытие замен действует только у вас.
                    Для заявки войдите в GitHub в браузере и отправьте открытый аддоном черновик через Submit new issue.
                    Публикацию подтверждает владелец.
                </div>
                <div className="uc-kv">
                    <div><span>Репозиторий</span><strong>{SHARED_REPO}</strong></div>
                    <div><span>Ветка</span><strong>main</strong></div>
                    <div><span>Токен</span><strong>не требуется</strong></div>
                </div>
                <div className="uc-row-actions uc-wrap">
                    <button type="button" className="uc-btn uc-btn-primary" disabled={saving} onClick={() => void connectShared()}>
                        {saving ? 'Подключаем…' : 'Подключить общую библиотеку'}
                    </button>
                    {state.config ? (
                        <button type="button" className="uc-btn uc-btn-small" disabled={saving} onClick={() => void checkAccess()}>
                            Проверить доступ
                        </button>
                    ) : null}
                </div>
                <div className="uc-muted uc-small uc-mt">
                    Заявки без доступа к репозиторию. GitHub-токен и приглашение в collaborators не нужны.
                </div>
            </section>

            {error ? <div className="uc-inline-error">{error}</div> : null}
            {success ? <div className="uc-check uc-ok-text">{success}</div> : null}

            <details className="uc-card uc-details">
                <summary>Вход владельца</summary>
                <div className="uc-details-body">
                <div className="uc-section-head">
                    <div>
                        <div className="uc-eyebrow">Подключение</div>
                        <div className="uc-section-title">Вход по GitHub-токену</div>
                    </div>
                    <span className={`uc-status-pill ${state.config ? 'uc-ok' : ''}`}>
                        {admin ? `Владелец: ${state.repoInfo?.viewer}` : 'Только для владельца'}
                    </span>
                </div>
                <div className="uc-hint">
                    Войдите личным fine-grained token владельца публичного репозитория, не через OAuth.
                    Contents и Actions: Read and write; Metadata: Read. Для загрузки cookies и прокси
                    дополнительно нужен Secrets: Read and write. Для принятия и отклонения заявок
                    в аддоне нужен Issues: Read and write; без него проверяйте заявки на сайте GitHub.
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
                        {saving ? 'Проверяем…' : 'Войти по токену / сохранить'}
                    </button>
                    <a className="uc-link uc-small" href={TOKEN_URL} target="_blank" rel="noreferrer">
                        Создать токен
                    </a>
                </div>
                <div className="uc-muted uc-small uc-mt">Токен не попадает в репозиторий и не передаётся в workflow.</div>
                </div>
            </details>

            {admin && state.config ? (
                <YoutubeCookies key={`${state.config.repo}:${state.config.branch}:${state.repoInfo?.viewer}`} />
            ) : null}

            {state.config ? (
                <section className="uc-card">
                    <div className="uc-section-head">
                        <div>
                            <div className="uc-eyebrow">Состояние</div>
                            <div className="uc-section-title">Доступ</div>
                        </div>
                        {admin ? (
                            <div className="uc-row-actions">
                                {state.repoInfo?.htmlUrl ? (
                                    <a
                                        className="uc-link uc-small"
                                        href={`${state.repoInfo.htmlUrl}/issues?q=is%3Aissue+is%3Aopen+label%3Auncensor-request`}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        Заявки
                                    </a>
                                ) : null}
                                {state.workflow?.htmlUrl ? (
                                    <a className="uc-link uc-small" href={state.workflow.htmlUrl} target="_blank" rel="noreferrer">
                                        Actions
                                    </a>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                    <div className="uc-kv">
                        <div><span>Репозиторий</span><strong>{state.config.repo}</strong></div>
                        <div><span>Ветка</span><strong>{state.config.branch}</strong></div>
                        <div><span>Аккаунт</span><strong>{state.repoInfo?.viewer || (state.hasToken ? 'проверяем…' : 'гость')}</strong></div>
                        <div><span>Права</span><strong>{accessLabel}</strong></div>
                        <div><span>Видимость</span><strong>{state.repoInfo?.private ? 'приватный — не подходит' : 'публичный'}</strong></div>
                        {admin ? <div><span>Contents</span><strong>{state.repoInfo?.canPush ? 'запись' : 'только чтение'}</strong></div> : null}
                        <div>
                            <span>Добавление</span>
                            <strong>{admin ? 'напрямую' : 'через браузер GitHub'}</strong>
                        </div>
                        {admin ? <div><span>Workflow</span><strong>{state.workflow?.state || 'не проверен'}</strong></div> : null}
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

            {admin ? <details className="uc-card uc-details">
                <summary>Подготовка репозитория</summary>
                <div className="uc-details-body">
                    <ol className="uc-steps">
                        <li><code>list.json</code> в корне ветки.</li>
                        <li><code>.github/workflows/uncensor-cloud.yml</code> и <code>uncensor-approve.yml</code>.</li>
                        <li><code>cloud/uncensor_worker.py</code> и <code>requirements.txt</code>.</li>
                        <li>Actions: <strong>Read and write permissions</strong>.</li>
                    </ol>
                    <div className="uc-hint">
                        Владельцу: Contents и Actions: Read and write, Metadata: Read.
                        Issues: Read and write нужен для решений по заявкам из аддона.
                        Без него ставьте метки на сайте GitHub. Гостям токен не нужен.
                    </div>
                    <div className="uc-muted uc-small">
                        Добавления друзей сначала попадают в GitHub Issues. Кнопка «Принять» ставит
                        <code> uncensor-local</code>: запись скачивает локальный помощник владельца и загружает
                        готовый файл в Releases. Метка <code>uncensor-rejected</code> отклоняет заявку.
                    </div>
                    <div className="uc-muted uc-small">
                        Публикуйте только записи, на которые у вас есть права. Репозиторий и аудиофайлы видны всем.
                    </div>
                </div>
            </details> : null}
        </div>
    )
}
