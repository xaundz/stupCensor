import type { AddonApi } from '@pulsesync/addon-sdk'

import type {
    AppNotice,
    GitHubConfig,
    JobError,
    JobRecord,
    LibraryIndex,
    RepoInfo,
    SetupForm,
    SetupResult,
    SourceCandidate,
    TrackMapping,
    TrackRef,
    TrackSearchMeta,
    WorkflowInfo,
} from './types.ts'
import {
    formatDateTime,
    isStableHttpsUrl,
    isYandexTrackId,
    normalizeRepoInput,
    sanitizeText,
} from './lib/format.ts'
import {
    EMPTY_INDEX,
    applyLibrary,
    applyOne,
    clearOwnReplacements,
    disableOne,
    parseIndex,
    reloadCurrentTrack,
} from './lib/library.ts'
import { GitHubClient, GitHubError } from './lib/github.ts'
import { resolveTrack } from './lib/tracks.ts'
import { settings } from './legacy/settings.ts'
import { SHARED_REPO } from './legacy/constants.ts'
import { buildRequestUrl } from './lib/requests.ts'

const CONFIG_KEY = 'stupidcensor.config.v1'
const TOKEN_KEY = 'stupidcensor.token.v1'
const DISABLED_KEY = 'stupidcensor.disabled.v1'
const REMOVED_KEY = 'stupidcensor.removed.v1'
const JOBS_KEY = 'stupidcensor.jobs.v1'
const CACHE_KEY = 'stupidcensor.library-cache.v1'

type CachedLibrary = {
    index: LibraryIndex
    fetchedAt: number
}

export type StoreState = {
    hydrated: boolean
    testAsUser: boolean
    config: GitHubConfig | null
    hasToken: boolean
    repoInfo: RepoInfo | null
    workflow: WorkflowInfo | null
    library: LibraryIndex
    libraryFetchedAt: number | null
    libraryFromCache: boolean
    disabled: string[]
    removed: string[]
    jobs: JobRecord[]
    busy: string
    notice: AppNotice | null
    lastError: string
}

const initialState: StoreState = {
    hydrated: false,
    testAsUser: false,
    config: null,
    hasToken: false,
    repoInfo: null,
    workflow: null,
    library: EMPTY_INDEX,
    libraryFetchedAt: null,
    libraryFromCache: false,
    disabled: [],
    removed: [],
    jobs: [],
    busy: '',
    notice: null,
    lastError: '',
}

let state: StoreState = initialState
let apiRef: AddonApi | null = null
let active = false
let token = ''
let polling = false
let libraryRefresh: Promise<LibraryIndex | null> | null = null
let libraryRevision = 0
let libraryRefreshRevision = 0
const deletedAssets = new Map<string, string>()
const terminalJobs = new Map<string, Promise<void>>()
let accessRevision = 0
const listeners = new Set<() => void>()

export function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function getState(): StoreState {
    return state
}

function emit(): void {
    for (const listener of listeners) listener()
}

function setState(patch: Partial<StoreState>): void {
    state = { ...state, ...patch }
    emit()
}

function requireApi(): AddonApi {
    if (!apiRef || !active) throw new Error('Аддон не активен.')
    return apiRef
}

function apiFor(api: AddonApi): GitHubClient {
    const config = state.config
    if (!config) throw new Error('Сначала укажите GitHub-репозиторий в разделе «GitHub».')
    return new GitHubClient(api, config.repo, isRepositoryAdmin() ? token : '', config.branch)
}

function storageSafe<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
}

function randomId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    return `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function validSet(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return [...new Set(value.filter(item => typeof item === 'string' && isYandexTrackId(item)))] as string[]
}

function normalizeError(error: unknown): JobError {
    if (error instanceof GitHubError) {
        return { code: error.code, message: error.message }
    }
    if (error instanceof Error) {
        return { code: 'error', message: error.message }
    }
    return { code: 'error', message: String(error) }
}

function errorText(error: unknown): string {
    return normalizeError(error).message
}

export function pushNotice(kind: AppNotice['kind'], text: string): void {
    setState({ notice: { kind, text, at: Date.now() } })
}

export function clearNotice(): void {
    setState({ notice: null })
}

export function setLastError(message: string): void {
    setState({ lastError: message })
}

function notifyUser(kind: 'info' | 'error', message: string): void {
    const api = apiRef
    if (!api) return
    const call = kind === 'error' ? api.notifications.error(message) : api.notifications.info(message)
    void call.catch(() => undefined)
}

function persistConfig(config: GitHubConfig | null): Promise<void> {
    const api = requireApi()
    return config ? api.storage.set(CONFIG_KEY, storageSafe(config)) : api.storage.remove(CONFIG_KEY)
}

function persistSets(): Promise<void> {
    const api = requireApi()
    return Promise.all([
        api.storage.set(DISABLED_KEY, storageSafe(state.disabled)),
        api.storage.set(REMOVED_KEY, storageSafe(state.removed)),
    ]).then(() => undefined)
}

function persistJobs(): Promise<void> {
    const api = requireApi()
    return api.storage.set(JOBS_KEY, storageSafe(state.jobs.slice(0, 30)))
}

function persistCache(index: LibraryIndex, fetchedAt: number): Promise<void> {
    const api = requireApi()
    return api.storage.set(CACHE_KEY, storageSafe({ index, fetchedAt } satisfies CachedLibrary))
}

export async function initialize(api: AddonApi): Promise<void> {
    libraryRevision++
    deletedAssets.clear()
    apiRef = api
    active = true
    if (api.signal.aborted) {
        active = false
        apiRef = null
        return
    }
    const [rawConfig, rawToken, rawDisabled, rawRemoved, rawJobs, rawCache] = await Promise.all([
        api.storage.get<GitHubConfig>(CONFIG_KEY).catch(() => undefined),
        api.storage.get<string>(TOKEN_KEY).catch(() => undefined),
        api.storage.get<string[]>(DISABLED_KEY).catch(() => undefined),
        api.storage.get<string[]>(REMOVED_KEY).catch(() => undefined),
        api.storage.get<JobRecord[]>(JOBS_KEY).catch(() => undefined),
        api.storage.get<CachedLibrary>(CACHE_KEY).catch(() => undefined),
    ])

    const config =
        rawConfig && typeof rawConfig === 'object' && normalizeRepoInput(String(rawConfig.repo || ''))
            ? {
                  repo: normalizeRepoInput(String(rawConfig.repo)),
                  branch: sanitizeText(rawConfig.branch, 200) || 'main',
                  rememberToken: rawConfig.rememberToken !== false,
                  publicVerified: rawConfig.publicVerified === true,
              }
            : { repo: SHARED_REPO, branch: 'main', rememberToken: false, publicVerified: false }
    token = config && config.rememberToken && typeof rawToken === 'string' ? rawToken : ''
    const disabled = validSet(rawDisabled)
    const removed = validSet(rawRemoved)
    const jobs = Array.isArray(rawJobs)
        ? rawJobs
              .filter(item => item && typeof item === 'object' && typeof item.id === 'string')
              .slice(0, 30)
              .map(item => ({
                  ...item,
                  status: item.status === 'published' || item.status === 'failed' || item.status === 'ready' ||
                      item.status === 'awaiting_approval' || item.status === 'updated' || item.status === 'removed' ||
                       item.status === 'abandoned' || item.status === 'rejected'
                      ? item.status
                      : item.status === 'running'
                          ? 'running'
                          : 'queued',
                  runUrl: typeof item.runUrl === 'string' && isStableHttpsUrl(item.runUrl) ? item.runUrl : undefined,
                   issueUrl: typeof item.issueUrl === 'string' && isStableHttpsUrl(item.issueUrl) ? item.issueUrl : undefined,
                   requestUrl: undefined,
              }) as JobRecord)
        : []
    let cached: CachedLibrary | null = null
    if (rawCache && typeof rawCache === 'object' && rawCache.index) {
        try {
            cached = { index: parseIndex(rawCache.index), fetchedAt: Number(rawCache.fetchedAt) || 0 }
        } catch {
            cached = null
        }
    }

    if (api.signal.aborted) {
        active = false
        apiRef = null
        return
    }
    setState({
        hydrated: true,
        testAsUser: false,
        repoInfo: null,
        workflow: null,
        config,
        hasToken: Boolean(token),
        disabled,
        removed,
        jobs,
        library: cached?.index ?? EMPTY_INDEX,
        libraryFetchedAt: cached?.fetchedAt ?? null,
        libraryFromCache: Boolean(cached),
    })
    accessRevision++
    if (!rawConfig) await persistConfig(config)
    for (const job of jobs) {
        if (!job.externalRequest) continue
        try {
            job.requestUrl = buildRequestUrl(job, job.requestSourceUrl || job.manualUrl)
        } catch {
            job.requestUrl = undefined
        }
    }

    if (cached && settings.store.autoApply) {
        try {
            await applyLibrary(api, cached.index, new Set(disabled), new Set(removed))
        } catch (error) {
            setLastError(`Не удалось применить сохранённые подмены: ${errorText(error)}`)
        }
    }

    api.setInterval(() => {
        if (!active) return
        void pollPendingJobs()
    }, 6500)

    api.onCleanup(() => {
        active = false
        apiRef = null
        void clearOwnReplacements(api)
    })

    if (config) {
        void refreshRepoAccess({ silent: true })
            .then(() => active && apiRef === api ? refreshLibrary({ silent: true, force: true }) : null)
            .catch(error => setLastError(errorText(error)))
    }
}

export function isRepositoryOwner(): boolean {
    const info = state.repoInfo
    return Boolean(state.hasToken && token && info?.canAdmin && info.viewer &&
        info.viewer.toLowerCase() === (info.owner || info.fullName.split('/')[0]).toLowerCase() &&
        info.fullName.toLowerCase() === state.config?.repo.toLowerCase())
}

export function isRepositoryAdmin(): boolean {
    return isRepositoryOwner() && !state.testAsUser
}

export function setTestAsUser(enabled: boolean): void {
    if (!isRepositoryOwner()) throw new Error('Тестовый режим доступен только подтверждённому владельцу.')
    accessRevision++
    libraryRevision++
    setState({ testAsUser: enabled, busy: '', notice: null })
}

export async function refreshRepoAccess(options: { silent?: boolean } = {}): Promise<RepoInfo | null> {
    const api = requireApi()
    if (!state.config) return null
    const revision = ++accessRevision
    const config = state.config
    const currentToken = token
    setState({ repoInfo: null, workflow: null })
    try {
        const client = new GitHubClient(api, config.repo, currentToken, config.branch)
        const info = await client.getAccessInfo()
        if (revision !== accessRevision || !active) return null
        setState({ repoInfo: info })
        if (info.canAdmin) {
            const workflow = await client.getWorkflow()
            if (revision !== accessRevision || !active) return null
            setState({ workflow })
        }
        return info
    } catch (error) {
        if (revision !== accessRevision || !active) return null
        setState({ repoInfo: null, workflow: null })
        if (!options.silent) setState({ lastError: errorText(error) })
        return null
    }
}

export async function saveSetup(form: SetupForm, options: { readOnly?: boolean } = {}): Promise<SetupResult> {
    const api = requireApi()
    const repo = normalizeRepoInput(form.repo)
    if (!repo) throw new Error('Укажите репозиторий в виде владелец/репозиторий или полной ссылкой GitHub.')
    const suppliedToken = form.token.trim()
    const effectiveToken = options.readOnly ? '' : suppliedToken || token
    const sameRepo = state.config?.repo === repo
    const rememberToken = options.readOnly ? false : form.rememberToken !== false
    const revision = ++accessRevision
    setState({ busy: 'setup', lastError: '', repoInfo: null, workflow: null, hasToken: false, testAsUser: false })
    try {
        const client = new GitHubClient(api, repo, effectiveToken, '')
        const result = await client.verifySetup()
        if (revision !== accessRevision || !active) throw new Error('Подключение GitHub изменилось. Повторите вход.')
        token = effectiveToken
        const config: GitHubConfig = {
            repo,
            branch: result.repo.defaultBranch,
            rememberToken,
            publicVerified: true,
        }
        await persistConfig(config)
        if (rememberToken && token) await api.storage.set(TOKEN_KEY, token)
        else await api.storage.remove(TOKEN_KEY)
        if (revision !== accessRevision || !active) throw new Error('Подключение GitHub изменилось. Повторите вход.')
        if (!sameRepo) {
            libraryRevision++
            deletedAssets.clear()
            await api.storage.remove(CACHE_KEY)
            setState({ library: EMPTY_INDEX, libraryFetchedAt: null, libraryFromCache: false })
        }
        setState({
            config,
            hasToken: Boolean(token),
            repoInfo: result.repo,
            workflow: result.workflow,
            disabled: [],
            removed: [],
            busy: '',
        })
        await persistSets()
        pushNotice('success', `Подключено: ${result.repo.fullName}, ветка ${result.repo.defaultBranch}.`)
        await refreshLibrary({ silent: true, force: true })
        return result
    } catch (error) {
        if (revision === accessRevision) setState({ busy: '', lastError: errorText(error), repoInfo: null, workflow: null })
        throw error
    }
}

export async function disconnectGitHub(forgetRepo: boolean): Promise<void> {
    const api = requireApi()
    token = ''
    accessRevision++
    libraryRevision++
    setState({ hasToken: false, repoInfo: null, workflow: null, testAsUser: false })
    await api.storage.remove(TOKEN_KEY)
    if (forgetRepo) {
        await persistConfig(null)
        await api.storage.remove(CACHE_KEY)
        setState({
            config: null,
            hasToken: false,
            repoInfo: null,
            workflow: null,
            library: EMPTY_INDEX,
            libraryFetchedAt: null,
            libraryFromCache: false,
        })
        await clearOwnReplacements(api)
    } else {
        const config = state.config ? { ...state.config, publicVerified: true } : null
        if (config) await persistConfig(config)
        setState({ hasToken: false })
    }
    pushNotice('info', forgetRepo ? 'Репозиторий отключён, регистрации подмен сняты.' : 'Токен удалён. Остался режим чтения.')
}

export async function refreshLibrary(options: {
    silent?: boolean
    force?: boolean
    published?: JobRecord
} = {}): Promise<LibraryIndex | null> {
    const api = requireApi()
    if (!state.config) {
        if (!options.silent) pushNotice('error', 'Сначала настройте репозиторий в разделе «GitHub».')
        return null
    }
    if (libraryRefresh && !options.force && libraryRefreshRevision === libraryRevision) return libraryRefresh
    const previous = libraryRefresh
    const revision = ++libraryRevision
    const config = state.config
    const currentToken = token
    const owner = isRepositoryAdmin()
    const inScope = () => active && apiRef === api && state.config === config && token === currentToken && revision === libraryRevision
    const refresh = async (): Promise<LibraryIndex | null> => {
        await previous?.catch(() => undefined)
        if (!inScope()) return null
        if (!options.silent) setState({ busy: 'library', lastError: '' })
        try {
            const client = apiFor(api)
            const index = await client.getIndex()
            if (!inScope() || owner !== isRepositoryAdmin()) return null
            if (!index) {
                setState({ busy: '', libraryFromCache: false, lastError: 'list.json не найден в репозитории.' })
                if (!options.silent) pushNotice('error', 'list.json не найден. Загрузите пример индекса в корень репозитория.')
                return null
            }
            const published = options.published
            const superseded = published && isTerminalSuperseded(published, index.tracks[published.trackId])
            if (published) {
                const mapping = index.tracks[published.trackId]
                if (!superseded && (!published.published?.audioUrl || !mapping || mapping.audioUrl !== published.published.audioUrl ||
                    (published.published.assetName && mapping.assetName !== published.published.assetName))) {
                    throw new Error('list.json ещё не содержит опубликованную запись. Повторите обновление задания.')
                }
                // A newer terminal result can arrive while this index request is in flight.
                if (superseded && !isLaterTimestamp(mapping?.updatedAt, published.finishedAt)) return state.library
            }
            for (const [trackId, audioUrl] of deletedAssets) {
                if (index.tracks[trackId]?.audioUrl === audioUrl) delete index.tracks[trackId]
            }
            setState({
                library: index,
                libraryFetchedAt: Date.now(),
                libraryFromCache: false,
                busy: '',
                lastError: '',
            })
            await persistCache(index, Date.now())
            if (!inScope()) return null
            if (settings.store.autoApply && !superseded) {
                await applyLibrary(api, index, new Set(state.disabled), new Set(state.removed), inScope)
            }
            if (!inScope()) return null
            if (!options.silent) {
                pushNotice('success', `Библиотека обновлена: ${Object.keys(index.tracks).length} связей.`)
            }
            return index
        } catch (error) {
            if (!inScope()) return null
            setState({ busy: '', lastError: errorText(error) })
            if (!options.silent) pushNotice('error', errorText(error))
            throw error
        }
    }
    const pending = refresh()
    libraryRefresh = pending
    libraryRefreshRevision = revision
    try {
        return await pending
    } finally {
        if (libraryRefresh === pending) libraryRefresh = null
    }
}

export async function resolveTrackForUi(seed: TrackRef): Promise<TrackRef> {
    return resolveTrack(requireApi(), seed)
}

export function findMapping(trackId: string): TrackMapping | null {
    return state.library.tracks[trackId] ?? null
}

export function isMappingEnabled(mapping: TrackMapping): boolean {
    return mapping.enabled && !state.disabled.includes(mapping.trackId) && !state.removed.includes(mapping.trackId)
}

export function isMappingHiddenLocally(mapping: TrackMapping): boolean {
    return !mapping.enabled || state.disabled.includes(mapping.trackId) || state.removed.includes(mapping.trackId)
}

export function jobForTrack(trackId: string, actions: JobRecord['action'][] = ['search']): JobRecord | null {
    return (
        state.jobs.find(
            job => job.trackId === trackId && actions.includes(job.action) && ['queued', 'running', 'ready'].includes(job.status),
        ) ?? null
    )
}

export function activeSearchJob(trackId: string): JobRecord | null {
    return jobForTrack(trackId, ['search'])
}

function createJob(
    action: JobRecord['action'],
    track: { id: string; title: string; artist: string },
    extra: Partial<JobRecord> = {},
): JobRecord {
    const config = state.config
    if (!config) throw new Error('Сначала настройте GitHub.')
    const now = new Date().toISOString()
    return {
        id: randomId(),
        action,
        status: 'queued',
        repo: config.repo,
        branch: config.branch,
        trackId: track.id,
        trackTitle: track.title,
        trackArtist: track.artist,
        createdAt: now,
        updatedAt: now,
        ...extra,
    }
}

function addJob(job: JobRecord): void {
    setState({ jobs: [job, ...state.jobs.filter(item => item.id !== job.id)].slice(0, 30) })
    void persistJobs()
}

function updateJobLocal(jobId: string, patch: Partial<JobRecord>): void {
    setState({
        jobs: state.jobs.map(job => (job.id === jobId ? { ...job, ...patch, updatedAt: new Date().toISOString() } : job)),
    })
    void persistJobs()
}

async function dispatchJob(api: AddonApi, job: JobRecord, inputs: Record<string, string>): Promise<void> {
    const config = state.config
    if (!config) throw new Error('Сначала настройте GitHub.')
    if (!isRepositoryAdmin()) throw new Error('Только подтверждённый владелец может запускать Actions.')
    try {
        const client = new GitHubClient(api, config.repo, token, config.branch)
        await client.dispatch(job.action, { job_id: job.id, ...inputs })
        pushNotice('info', 'Задание отправлено в GitHub Actions. Ожидаем выполнения…')
    } catch (error) {
        const normalized = normalizeError(error)
        updateJobLocal(job.id, { status: 'failed', error: normalized })
        notifyUser('error', normalized.message)
        throw error
    }
}

function queueBrowserRequest(job: JobRecord, sourceUrl = ''): JobRecord {
    job.externalRequest = true
    job.auto = false
    job.requestUrl = buildRequestUrl(job, sourceUrl)
    job.requestSourceUrl = sourceUrl || undefined
    job.expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString()
    job.note = 'Черновик открыт в браузере. Нужно вручную отправить страницу GitHub (Submit new issue); открытие страницы не отправляет заявку.'
    addJob(job)
    pushNotice('info', job.note)
    try {
        window.open(job.requestUrl, '_blank', 'noopener,noreferrer')
    } catch {
        // The exposed requestUrl allows reopening when the browser blocks the popup.
    }
    return job
}

export async function startSearch(
    track: TrackRef,
    meta: TrackSearchMeta,
    sourceUrl: string,
    options: { auto?: boolean } = {},
): Promise<JobRecord> {
    const api = requireApi()
    if (!isYandexTrackId(track.id)) throw new Error('Некорректный ID трека Яндекс Музыки.')
    if (sourceUrl.trim() && !isStableHttpsUrl(sourceUrl.trim())) throw new Error('Ссылка на источник должна быть постоянной HTTPS-ссылкой без временных подписей.')
    const job = createJob(
        'search',
        { id: track.id, title: meta.title, artist: meta.artist },
        {
            auto: isRepositoryAdmin() && options.auto === true,
            trackDurationMs: Math.max(0, Math.round(meta.durationMs || 0)),
        },
    )
    if (!isRepositoryAdmin()) return queueBrowserRequest(job, sourceUrl.trim())
    addJob(job)
    await dispatchJob(api, job, {
        track_id: track.id,
        artist: meta.artist,
        title: meta.title,
        duration: String(Math.max(0, Math.round(meta.durationMs / 1000))),
        source_url: sourceUrl.trim(),
    })
    return job
}

const AUTO_REJECT_WARNINGS = [
    'кавер',
    'перепев',
    'ремикс',
    'мэшап',
    'инструменталь',
    'минус',
    'караоке',
    'концертная',
    'изменён темп',
    'обработка ии',
    'слабое совпадение',
    'автор загрузившего не совпадает',
]

function autoCandidate(job: JobRecord): SourceCandidate | null {
    const candidates = Array.isArray(job.candidates)
        ? job.candidates.filter(candidate => candidate.provider === 'youtube' || candidate.provider === 'soundcloud')
        : []
    if (!candidates.length) return null
    const targetMs = Math.max(0, job.trackDurationMs || 0)
    const ranked = candidates
        .filter(candidate => {
            if (candidate.unavailable) return false
            if (!targetMs || !candidate.durationMs) return false
            if (candidate.score < 0.72) return false
            const warnings = (Array.isArray(candidate.warnings) ? candidate.warnings : []).map(warning => warning.toLowerCase())
            if (warnings.some(warning => AUTO_REJECT_WARNINGS.some(pattern => warning.includes(pattern)))) return false
            if (Math.abs(candidate.durationMs - targetMs) > 5000) return false
            return true
        })
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score
            if (!targetMs) return 0
            return Math.abs(a.durationMs - targetMs) - Math.abs(b.durationMs - targetMs)
        })
    return ranked[0] ?? null
}

export async function startAutoReplace(track: TrackRef): Promise<JobRecord | null> {
    const api = requireApi()
    if (!state.config) throw new Error('Сначала подключите GitHub-репозиторий в меню stupidCensor.')
    if (!isYandexTrackId(track.id)) throw new Error('Не удалось определить ID трека Яндекс Музыки.')

    const existing = jobForTrack(track.id, ['search'])
    if (existing) {
        if (existing.status === 'ready') {
            pushNotice('info', `Кандидаты для «${existing.trackTitle}» уже готовы. Выберите запись в панели.`)
        } else {
            pushNotice('info', `Поиск для «${existing.trackTitle}» уже выполняется.`)
        }
        return existing
    }
    const currentMapping = findMapping(track.id)
    if (currentMapping && isMappingEnabled(currentMapping)) {
        pushNotice('success', 'Для этого трека уже есть активная замена.')
        return null
    }

    const resolved = await resolveTrack(api, track)
    const meta: TrackSearchMeta = {
        id: resolved.id,
        title: (resolved.title || track.title || '').trim(),
        artist: (resolved.artist || track.artist || '').trim(),
        durationMs: Math.max(0, resolved.durationMs || track.durationMs || 0),
    }
    if (!meta.title || !meta.artist) {
        throw new Error('Не удалось определить исполнителя и название трека. Откройте панель stupidCensor.')
    }
    notifyUser('info', `Ищу запись без цензуры: ${meta.artist} — ${meta.title}.`)
    const job = await startSearch(resolved, meta, '', { auto: true })
    if (!job.externalRequest) pushNotice('info', 'Автопоиск запущен в GitHub Actions. Можно продолжать слушать музыку.')
    return job
}

export function markJobReviewed(jobId: string): void {
    setState({
        jobs: state.jobs.map(job => (job.id === jobId ? { ...job, needsReview: false, updatedAt: new Date().toISOString() } : job)),
    })
    void persistJobs()
}

export async function confirmCandidate(sourceJob: JobRecord, candidate: SourceCandidate): Promise<JobRecord> {
    const api = requireApi()
    if (sourceJob.repo !== state.config?.repo) throw new Error('Задание относится к другому репозиторию.')
    if (!sourceJob.candidates?.some(item => item.id === candidate.id)) {
        throw new Error('Кандидат не найден в исходном задании.')
    }
    const awaiting = state.jobs.find(
        job =>
            job.trackId === sourceJob.trackId &&
            (job.action === 'confirm' || job.action === 'manual') &&
            job.status === 'awaiting_approval',
    )
    if (awaiting) {
        throw new Error('Заявка для этого трека уже ждёт проверки владельцем. Откройте «Задания» в панели.')
    }
    if (candidate.unavailable) {
        throw new Error(candidate.unavailableReason || 'Этот источник помечен как недоступный. Выберите другую запись.')
    }
    const job = createJob(
        'confirm',
        { id: sourceJob.trackId, title: sourceJob.trackTitle, artist: sourceJob.trackArtist },
        { sourceJobId: sourceJob.id, candidateId: candidate.id, trackDurationMs: candidate.durationMs },
    )
    if (!isRepositoryAdmin()) return queueBrowserRequest(job)
    addJob(job)
    await dispatchJob(api, job, {
        track_id: sourceJob.trackId,
        artist: sourceJob.trackArtist,
        title: sourceJob.trackTitle,
        duration: String(Math.round((sourceJob.candidates.find(item => item.id === candidate.id)?.durationMs || 0) / 1000)),
        source_job_id: sourceJob.id,
        candidate_id: candidate.id,
    })
    return job
}

export async function startAuthCheck(): Promise<JobRecord> {
    const api = requireApi()
    if (!isRepositoryAdmin()) throw new Error('Проверка YouTube доступна только владельцу репозитория.')
    const job = createJob('check', { id: '0', title: 'Проверка YouTube', artist: '' })
    addJob(job)
    await dispatchJob(api, job, {
        track_id: '0',
        title: 'Проверка YouTube',
        artist: '',
        duration: '0',
    })
    return job
}

export async function startManualAdd(track: TrackRef, meta: TrackSearchMeta, directUrl: string): Promise<JobRecord> {
    const api = requireApi()
    const awaiting = state.jobs.find(
        job =>
            job.trackId === track.id &&
            (job.action === 'confirm' || job.action === 'manual') &&
            job.status === 'awaiting_approval',
    )
    if (awaiting) {
        throw new Error('Заявка для этого трека уже ждёт проверки владельцем. Откройте «Задания» в панели.')
    }
    const url = directUrl.trim()
    if (!isStableHttpsUrl(url)) {
        throw new Error('Нужна постоянная HTTPS-ссылка без временных подписей (например, Releases вашего репозитория).')
    }
    if (/(?:^|\.)(?:spotify\.com|music\.apple\.com|deezer\.com|music\.yandex\.[a-z]+|rutube\.ru|dailymotion\.com|dai\.ly|vimeo\.com|bandcamp\.com|vk\.com|vkvideo\.ru)$/i.test(new URL(url).hostname)) {
        throw new Error('Этот сервис не поддерживается. Используйте YouTube, SoundCloud или прямую HTTPS-ссылку на аудиофайл.')
    }
    const job = createJob('manual', { id: track.id, title: meta.title, artist: meta.artist })
    job.manualUrl = url
    job.trackDurationMs = meta.durationMs
    if (!isRepositoryAdmin()) return queueBrowserRequest(job, url)
    addJob(job)
    await dispatchJob(api, job, {
        track_id: track.id,
        artist: meta.artist,
        title: meta.title,
        duration: String(Math.max(0, Math.round(meta.durationMs / 1000))),
        source_url: url,
    })
    return job
}

export async function startBatchSearch(
    tracks: TrackRef[],
    limit = 10,
): Promise<{ started: number; skipped: number; failed: number }> {
    const api = requireApi()
    if (!isRepositoryAdmin()) throw new Error('Массовый поиск доступен только владельцу. Для отдельного трека откройте заявку в браузере.')
    if (!state.config) throw new Error('Сначала подключите GitHub-репозиторий.')
    const unique: TrackRef[] = []
    const seen = new Set<string>()
    for (const track of tracks) {
        if (!track?.id || seen.has(track.id) || !isYandexTrackId(track.id)) continue
        seen.add(track.id)
        unique.push(track)
    }
    let started = 0
    let skipped = 0
    let failed = 0
    for (const track of unique.slice(0, Math.max(1, Math.min(20, limit)))) {
        const mapping = findMapping(track.id)
        if (mapping && isMappingEnabled(mapping)) {
            skipped += 1
            continue
        }
        if (jobForTrack(track.id, ['search'])) {
            skipped += 1
            continue
        }
        try {
            const resolved = !track.title?.trim() || !track.artist?.trim() ? await resolveTrack(api, track) : track
            const title = (resolved.title || track.title || '').trim()
            const artist = (resolved.artist || track.artist || '').trim()
            if (!title || !artist) {
                skipped += 1
                continue
            }
            await startSearch(resolved, {
                id: resolved.id,
                title,
                artist,
                durationMs: Math.max(0, resolved.durationMs || track.durationMs || 0),
            }, '')
            started += 1
        } catch {
            failed += 1
        }
    }
    if (started) {
        pushNotice('success', `Массовый поиск: запущено ${started}, пропущено ${skipped}${failed ? `, ошибок ${failed}` : ''}.`)
    } else if (failed) {
        pushNotice('error', `Массовый поиск не запустился: ошибок ${failed}, пропущено ${skipped}.`)
    } else {
        pushNotice('info', skipped ? 'Все треки из очереди уже имеют замену или активный поиск.' : 'В очереди нет треков.')
    }
    return { started, skipped, failed }
}

export async function setMappingEnabled(trackId: string, enabled: boolean): Promise<void> {
    const api = requireApi()
    const mapping = findMapping(trackId)
    if (!mapping) return
    if (!isRepositoryAdmin() && !mapping.enabled) {
        pushNotice('info', 'Замена отключена владельцем библиотеки.')
        return
    }
    const disabled = new Set(state.disabled)
    const removed = new Set(state.removed)
    if (enabled) {
        disabled.delete(trackId)
        removed.delete(trackId)
    } else {
        disabled.add(trackId)
        removed.delete(trackId)
    }
    setState({ disabled: [...disabled], removed: [...removed] })
    await persistSets()
    try {
        if (enabled) await applyOne(api, mapping)
        else await disableOne(api, trackId)
        if (settings.store.autoApply) {
            const result = await reloadCurrentTrack(api, trackId)
            if (result === 'restart-required') {
                pushNotice('info', 'Подмена изменена. Перезапустите текущий трек, чтобы услышать результат.')
            }
        }
    } catch (error) {
        pushNotice('error', `Не удалось применить подмену: ${errorText(error)}`)
    }
    if (isRepositoryAdmin() && token && state.config) {
        const job = createJob('toggle', { id: trackId, title: mapping.title, artist: mapping.artists.join(', ') }, { silent: true })
        addJob(job)
        try {
            await dispatchJob(api, job, { track_id: trackId, enabled: enabled ? 'true' : 'false' })
        } catch (error) {
            pushNotice('error', `Локально применено, но в GitHub не сохранено: ${errorText(error)}`)
        }
    } else if (token && state.config) {
        pushNotice('info', 'Изменение применено только у вас. В общей библиотеке его может сохранить владелец.')
    } else {
        pushNotice('info', 'Изменение применено локально. Для сохранения в облаке подключите токен.')
    }
}

export async function removeMapping(trackId: string): Promise<void> {
    const api = requireApi()
    const mapping = findMapping(trackId)
    if (!mapping) return
    const removed = new Set(state.removed)
    removed.add(trackId)
    const disabled = new Set(state.disabled)
    disabled.delete(trackId)
    setState({ removed: [...removed], disabled: [...disabled] })
    await persistSets()
    try {
        await disableOne(api, trackId)
        const reload = await reloadCurrentTrack(api, trackId)
        if (reload === 'restart-required') pushNotice('info', 'Связь скрыта локально. Перезапустите текущий трек, чтобы остановить старую подмену.')
    } catch (error) {
        pushNotice('error', `Не удалось снять регистрацию: ${errorText(error)}`)
    }
    if (isRepositoryAdmin() && token && state.config) {
        const job = createJob('remove', { id: trackId, title: mapping.title, artist: mapping.artists.join(', ') }, { silent: true })
        addJob(job)
        try {
            await dispatchJob(api, job, { track_id: trackId })
            pushNotice('info', 'Удаление из индекса и Releases отправлено в GitHub.')
        } catch (error) {
            pushNotice('error', `Связь скрыта локально, но GitHub не обновился: ${errorText(error)}`)
        }
    } else if (isRepositoryAdmin() && !token) {
        pushNotice('info', 'Связь скрыта локально. Для удаления из GitHub подключите токен.')
    } else {
        pushNotice('info', 'Связь скрыта только у вас. Общая библиотека не изменилась.')
    }
}

export async function restoreMapping(trackId: string): Promise<void> {
    const removed = new Set(state.removed)
    removed.delete(trackId)
    setState({ removed: [...removed] })
    await persistSets()
    try {
        await refreshLibrary({ silent: true })
        if (!findMapping(trackId)) {
            pushNotice('info', 'Связь уже удалена из list.json. Чтобы вернуть запись, добавьте её заново.')
            return
        }
        pushNotice('success', 'Связь снова доступна. Если она выключена, включите её тумблером.')
    } catch (error) {
        pushNotice('error', `Локально связь возвращена, но список не обновился: ${errorText(error)}`)
    }
}

export function forgetJob(jobId: string): void {
    setState({ jobs: state.jobs.filter(job => job.id !== jobId) })
    void persistJobs()
}

const MEDIA_PROVIDERS = [
    'youtube',
    'soundcloud',
] as const

function isMediaProvider(value: unknown): value is SourceCandidate['provider'] {
    return typeof value === 'string' && (MEDIA_PROVIDERS as readonly string[]).includes(value)
}

function parseCandidate(raw: unknown): SourceCandidate | null {
    if (!raw || typeof raw !== 'object') return null
    const item = raw as Record<string, unknown>
    const id = sanitizeText(item.id, 120)
    const provider = isMediaProvider(item.provider) ? item.provider : null
    const pageUrl = sanitizeText(item.pageUrl, 2000)
    if (!id || !provider || !isStableHttpsUrl(pageUrl)) return null
    return {
        id,
        provider,
        pageUrl,
        title: sanitizeText(item.title, 400) || 'Без названия',
        artist: sanitizeText(item.artist, 400),
        uploader: sanitizeText(item.uploader, 300),
        durationMs: Math.max(0, Number(item.durationMs) || 0),
        score: Math.max(0, Math.min(1, Number(item.score) || 0)),
        warnings: Array.isArray(item.warnings)
            ? item.warnings.map(value => sanitizeText(value, 160)).filter(Boolean).slice(0, 12)
            : [],
        unavailable: item.unavailable === true,
        unavailableReason: sanitizeText(item.unavailableReason, 300) || undefined,
    }
}

function safeJobUrl(value: unknown, fallback: string | undefined): string | undefined {
    const clean = sanitizeText(value, 1000)
    return clean && isStableHttpsUrl(clean) ? clean : fallback
}

function mergeRemoteJob(job: JobRecord, remote: Record<string, unknown>): JobRecord {
    const statusRaw = sanitizeText(remote.status, 30)
    const status = (['queued', 'running', 'ready', 'awaiting_approval', 'published', 'failed', 'updated', 'removed', 'abandoned', 'rejected'] as const).includes(
        statusRaw as JobRecord['status'],
    )
        ? (statusRaw as JobRecord['status'])
        : job.status
    const candidates = Array.isArray(remote.candidates)
        ? remote.candidates.map(parseCandidate).filter((item): item is SourceCandidate => Boolean(item))
        : job.candidates
    const errorRaw = remote.error
    const error =
        errorRaw && typeof errorRaw === 'object'
            ? {
                  code: sanitizeText((errorRaw as Record<string, unknown>).code, 80) || 'error',
                  message: sanitizeText((errorRaw as Record<string, unknown>).message, 600) || 'Неизвестная ошибка',
                  detail: sanitizeText((errorRaw as Record<string, unknown>).detail, 1600) || undefined,
              }
            : job.error
    const publishedRaw = remote.published
    const published =
        publishedRaw && typeof publishedRaw === 'object'
            ? {
                  audioUrl: sanitizeText((publishedRaw as Record<string, unknown>).audioUrl, 2000),
                  assetName: sanitizeText((publishedRaw as Record<string, unknown>).assetName, 300),
              }
            : job.published
    const remoteUpdatedAt = sanitizeText(remote.updatedAt, 40)
    const startedAt =
        sanitizeText(remote.startedAt, 40) ||
        job.startedAt ||
        (status === 'running' && remoteUpdatedAt ? remoteUpdatedAt : undefined)
    return {
        ...job,
        status: job.cancelRequested && (status === 'queued' || status === 'running') ? 'abandoned' : status,
        candidates,
        error,
        published,
        removedAudioUrl: typeof remote.removedAudioUrl === 'string'
            ? sanitizeText(remote.removedAudioUrl, 2000)
            : job.removedAudioUrl,
        expiresAt: sanitizeText(remote.expiresAt, 40) || job.expiresAt,
        runUrl: safeJobUrl(remote.runUrl, job.runUrl),
        issueUrl: safeJobUrl(remote.issueUrl, job.issueUrl),
        issueNumber: Math.max(0, Number(remote.issueNumber) || job.issueNumber || 0) || undefined,
        requestedBy: sanitizeText(remote.requestedBy, 80) || job.requestedBy,
        startedAt,
        finishedAt: ['ready', 'published', 'failed', 'updated', 'removed', 'abandoned', 'rejected'].includes(status)
            ? sanitizeText(remote.finishedAt, 40) || remoteUpdatedAt || job.finishedAt
            : job.finishedAt,
        etaSeconds: Math.max(0, Number(remote.etaSeconds) || job.etaSeconds || 0) || undefined,
        note: sanitizeText(remote.note, 600) || job.note,
        updatedAt: new Date().toISOString(),
    }
}

function isLaterTimestamp(value: string | undefined, than: string | undefined): boolean {
    const time = Date.parse(value || '')
    const previous = Date.parse(than || '')
    return Number.isFinite(time) && Number.isFinite(previous) && time > previous
}

function isTerminalSuperseded(job: JobRecord, mapping: TrackMapping | undefined): boolean {
    return isLaterTimestamp(mapping?.updatedAt, job.finishedAt) || state.jobs.some(other =>
        other.id !== job.id && other.repo === job.repo && other.branch === job.branch && other.trackId === job.trackId &&
        ['published', 'removed', 'updated'].includes(other.status) && isLaterTimestamp(other.finishedAt, job.finishedAt))
}

async function handleTerminalJob(job: JobRecord): Promise<void> {
    const key = JSON.stringify([job.repo, job.branch, job.trackId])
    const previous = terminalJobs.get(key)
    const api = apiRef
    const config = state.config
    const currentToken = token
    const pending = (async () => {
        await previous?.catch(() => undefined)
        if (!active || apiRef !== api || state.config !== config || token !== currentToken) return
        const current = state.jobs.find(item => item.id === job.id)
        if (!current || current.processed || current.cancelRequested) return
        await processTerminalJob(current)
    })()
    terminalJobs.set(key, pending)
    try {
        await pending
    } finally {
        if (terminalJobs.get(key) === pending) terminalJobs.delete(key)
    }
}

async function processTerminalJob(job: JobRecord): Promise<void> {
    if (['published', 'removed', 'updated'].includes(job.status) && isTerminalSuperseded(job, state.library.tracks[job.trackId])) {
        updateJobLocal(job.id, { processed: true })
        return
    }
    if (job.action === 'check' && !job.processed) {
        updateJobLocal(job.id, { processed: true })
        if (job.status === 'ready') {
            const message = job.note || 'YouTube доступен.'
            notifyUser('info', message)
            pushNotice('success', message)
        } else if (job.status === 'failed') {
            const message = job.error?.message || 'Проверка YouTube завершилась с ошибкой.'
            notifyUser('error', message)
            pushNotice('error', message)
        }
        return
    }
    if (job.status === 'ready' && !job.processed) {
        if (job.auto && !job.externalRequest && isRepositoryAdmin()) {
            const candidate = autoCandidate(job)
            if (candidate) {
                updateJobLocal(job.id, { processed: true, autoConfirmed: true })
                notifyUser('info', `Уверенное совпадение для «${job.trackTitle}»: ${candidate.title}. Сохраняю в GitHub.`)
                pushNotice('info', `Найдено совпадение (${Math.round(candidate.score * 100)}%). Публикую автоматически.`)
                try {
                    await confirmCandidate(job, candidate)
                } catch (error) {
                    updateJobLocal(job.id, { processed: true })
                    pushNotice('error', `Автосохранение не запустилось: ${errorText(error)}`)
                    notifyUser('error', `Автосохранение не запустилось: ${errorText(error)}`)
                }
                return
            }
            updateJobLocal(job.id, { processed: true, needsReview: true })
            notifyUser('info', `Для «${job.trackTitle}» нужно подтверждение: уверенного совпадения нет.`)
            pushNotice('info', 'Автопоиск нашёл кандидатов, но нужно подтвердить запись вручную.')
            return
        }
        updateJobLocal(job.id, { processed: true })
        notifyUser('info', `Кандидаты готовы для «${job.trackTitle}». Откройте задание, чтобы выбрать запись.`)
        pushNotice('success', `Готово: ${job.candidates?.length || 0} кандидатов для «${job.trackTitle}».`)
        return
    }
    if (job.status === 'published' && !job.processed) {
        const api = apiRef
        if (!api) return
        const config = state.config
        const currentToken = token
        const inScope = () => active && apiRef === api && state.config === config && token === currentToken
        try {
            const index = await refreshLibrary({ silent: true, force: true, published: job })
            if (!index || !inScope()) return
            const mapping = index.tracks[job.trackId]
            if (isTerminalSuperseded(job, mapping)) {
                updateJobLocal(job.id, { processed: true })
                return
            }
            if (!mapping || mapping.audioUrl !== job.published?.audioUrl) throw new Error('Опубликованная запись не найдена в библиотеке.')
            setState({
                disabled: state.disabled.filter(id => id !== job.trackId),
                removed: state.removed.filter(id => id !== job.trackId),
            })
            await persistSets()
            if (!inScope()) return
            if (isTerminalSuperseded(job, state.library.tracks[job.trackId])) return updateJobLocal(job.id, { processed: true })
            await applyOne(api, mapping)
            if (!inScope()) return
            if (isTerminalSuperseded(job, state.library.tracks[job.trackId])) return updateJobLocal(job.id, { processed: true })
            const reload = await reloadCurrentTrack(api, job.trackId)
            if (!inScope()) return
            if (isTerminalSuperseded(job, state.library.tracks[job.trackId])) return updateJobLocal(job.id, { processed: true })
            updateJobLocal(job.id, { processed: true })
            if (reload === 'reloaded') {
                notifyUser('info', `Подмена сохранена и применена к текущему треку: «${job.trackTitle}».`)
                pushNotice('success', 'Подмена применена к текущему треку.')
            } else if (reload === 'restart-required') {
                notifyUser('info', `Подмена сохранена. Перезапустите трек «${job.trackTitle}».`)
                pushNotice('success', 'Подмена сохранена. Перезапустите текущий трек, чтобы применить её.')
            } else {
                notifyUser('info', `Подмена сохранена: «${job.trackTitle}».`)
                pushNotice('success', 'Подмена сохранена в облаке. Она применится при следующем воспроизведении.')
            }
        } catch (error) {
            if (!inScope()) return
            pushNotice('error', `Аудио опубликовано, но библиотека не обновилась: ${errorText(error)}`)
        }
        return
    }
    if ((job.status === 'failed' || job.status === 'rejected') && !job.processed) {
        updateJobLocal(job.id, { processed: true })
        const message = job.error?.message || 'Задание завершилось с ошибкой.'
        notifyUser('error', message)
        pushNotice('error', message)
        return
    }
    if ((job.status === 'updated' || job.status === 'removed') && !job.processed) {
        const api = apiRef
        const config = state.config
        const currentToken = token
        if (!api) return
        const inScope = () => active && apiRef === api && state.config === config && token === currentToken
        if (job.status === 'removed') {
            const mapping = findMapping(job.trackId)
            const superseded = () => {
                const current = state.library.tracks[job.trackId]
                return isTerminalSuperseded(job, current) ||
                    (job.removedAudioUrl !== undefined && current && current.audioUrl !== job.removedAudioUrl)
            }
            if (job.removedAudioUrl !== undefined) {
                if (!job.removedAudioUrl || (mapping && mapping.audioUrl !== job.removedAudioUrl)) {
                    updateJobLocal(job.id, { processed: true })
                    return
                }
                deletedAssets.set(job.trackId, job.removedAudioUrl)
                // Invalidate a pre-deletion fetch before awaiting local player operations.
                libraryRevision++
                const tracks = { ...state.library.tracks }
                delete tracks[job.trackId]
                setState({ library: { ...state.library, tracks } })
                await persistCache(state.library, Date.now())
                if (!inScope()) return
                if (superseded()) return updateJobLocal(job.id, { processed: true })
                await disableOne(api, job.trackId)
                if (!inScope()) return
                if (superseded()) return updateJobLocal(job.id, { processed: true })
                await reloadCurrentTrack(api, job.trackId)
            } else {
                // Legacy statuses cannot identify the deleted asset; trust the current index.
                const index = await refreshLibrary({ silent: true, force: true })
                if (!index || !inScope()) return
                if (!index.tracks[job.trackId] && !isTerminalSuperseded(job, undefined)) {
                    await disableOne(api, job.trackId)
                    if (!inScope()) return
                    if (state.library.tracks[job.trackId] || superseded()) return updateJobLocal(job.id, { processed: true })
                    await reloadCurrentTrack(api, job.trackId)
                }
                if (inScope()) updateJobLocal(job.id, { processed: true })
                return
            }
        }
        if (!active || apiRef !== api || state.config !== config || token !== currentToken) return
        const index = await refreshLibrary({ silent: true, force: true })
        if (index && active && state.config === config && token === currentToken) updateJobLocal(job.id, { processed: true })
    }
}

async function pollJob(job: JobRecord): Promise<void> {
    const api = apiRef
    if (!api) return
    const config = state.config
    const currentToken = token
    const inScope = () => active && apiRef === api && state.config === config && token === currentToken &&
        state.jobs.some(item => item.id === job.id && !item.cancelRequested)
    if (!config || job.repo !== config.repo || job.branch !== config.branch || !inScope()) return
    if (['published', 'removed', 'updated'].includes(job.status)) {
        await handleTerminalJob(job)
        return
    }
    if (job.externalRequest && (job.cancelRequested || ['abandoned', 'rejected'].includes(job.status))) return
    const ageMs = Date.now() - new Date(job.createdAt).getTime()
    const expiry = job.issueUrl && job.expiresAt ? Date.parse(job.expiresAt) : new Date(job.createdAt).getTime() + 24 * 60 * 60_000
    if (job.externalRequest && (!Number.isFinite(expiry) || Date.now() > expiry)) {
        updateJobLocal(job.id, { status: 'abandoned', processed: true, note: 'Срок локального отслеживания истёк. Статус заявки можно проверить в GitHub.' })
        return
    }
    const client = new GitHubClient(api, job.repo, job.externalRequest ? '' : token, job.branch)
    const remote = await client.getJob(job.id)
    if (!inScope()) return
    if (remote) {
        const current = state.jobs.find(item => item.id === job.id)!
        const merged = mergeRemoteJob(current, remote)
        updateJobLocal(job.id, merged)
        await handleTerminalJob(merged)
        return
    }
    if (job.externalRequest || job.status === 'awaiting_approval') return
    if (ageMs > 20_000) {
        const run = await client.getRunForJob(job.id)
        if (!inScope()) return
        if (run) {
            const patch: Partial<JobRecord> = { runUrl: isStableHttpsUrl(run.htmlUrl) ? run.htmlUrl : undefined, runId: run.id }
            if (run.startedAt && !job.startedAt) patch.startedAt = run.startedAt
            if (run.status === 'completed') {
                if (run.conclusion === 'success') {
                    patch.status = 'failed'
                    patch.error = {
                        code: 'missing_status',
                        message: 'Workflow завершился, но не записал файл статуса. Откройте журнал Actions.',
                    }
                } else {
                    patch.status = 'failed'
                    patch.error = {
                        code: `workflow_${run.conclusion || 'failed'}`,
                        message: `Workflow завершился: ${run.conclusion || 'без успеха'}. Откройте журнал Actions.`,
                    }
                }
                const next = { ...job, ...patch, updatedAt: new Date().toISOString() }
                updateJobLocal(job.id, patch)
                await handleTerminalJob(next)
                return
            }
            if (run.status === 'queued' || run.status === 'in_progress') {
                patch.status = run.status === 'queued' ? 'queued' : 'running'
                updateJobLocal(job.id, patch)
                return
            }
        }
        if (ageMs > 120_000) {
            const patch: Partial<JobRecord> = {
                status: 'failed',
                error: {
                    code: 'workflow_not_started',
                    message: 'GitHub Actions не запустил workflow за 2 минуты. Проверьте, что Actions включены и workflow есть в ветке.',
                },
            }
            const next = { ...job, ...patch, updatedAt: new Date().toISOString() }
            updateJobLocal(job.id, patch)
            await handleTerminalJob(next)
            return
        }
    }
    if (ageMs > 45 * 60_000) {
        const patch: Partial<JobRecord> = {
            status: 'failed',
            error: {
                code: 'timeout',
                message: 'Задание не завершилось за 45 минут. Проверьте журнал GitHub Actions.',
            },
        }
        const next = { ...job, ...patch, updatedAt: new Date().toISOString() }
        updateJobLocal(job.id, patch)
        await handleTerminalJob(next)
    }
}

export async function pollPendingJobs(): Promise<void> {
    if (polling || !active) return
    const pending = state.jobs.slice(0, 30).filter(job =>
        (job.externalRequest || token) && !job.cancelRequested &&
        (['queued', 'running', 'awaiting_approval'].includes(job.status) ||
            (!job.processed && ['published', 'removed', 'updated'].includes(job.status))))
    if (!pending.length) return
    const config = state.config
    const currentToken = token
    const api = apiRef
    const inScope = () => active && apiRef === api && state.config === config && token === currentToken
    polling = true
    try {
        let next = 0
        await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
            while (next < pending.length && inScope()) {
                const job = pending[next++]!
                if (job.repo !== config?.repo) continue
                try {
                    await pollJob(job)
                } catch (error) {
                    if (inScope() && error instanceof GitHubError && (error.status === 401 || error.status === 403 || error.status === 404)) {
                        setLastError(error.message)
                    }
                }
            }
        }))
    } finally {
        polling = false
    }
}

export async function resumePendingJobs(): Promise<void> {
    await pollPendingJobs()
}

export async function refreshJob(jobId: string): Promise<void> {
    const job = state.jobs.find(item => item.id === jobId)
    if (!job) return
    if (job.repo !== state.config?.repo) throw new Error('Задание относится к другому репозиторию.')
    if (!token && !job.externalRequest) throw new Error('Для проверки статуса нужен GitHub-токен.')
    await pollJob(job)
}

export async function cancelJob(jobId: string): Promise<void> {
    const api = requireApi()
    const job = state.jobs.find(item => item.id === jobId)
    if (!job) return
    if (job.externalRequest) {
        forgetJob(jobId)
        pushNotice('info', 'Отменено только локальное отслеживание. Заявка и действия в GitHub не отменены.')
        return
    }
    if (job.status !== 'queued' && job.status !== 'running') return
    if (!isRepositoryAdmin()) throw new Error('Отмена Actions доступна только владельцу репозитория.')
    const client = new GitHubClient(api, job.repo, token, job.branch)
    let runId = job.runId
    if (!runId) {
        const run = await client.getRunForJob(job.id)
        if (run) {
            runId = run.id
            updateJobLocal(job.id, {
                runId: run.id,
                runUrl: isStableHttpsUrl(run.htmlUrl) ? run.htmlUrl : job.runUrl,
                startedAt: job.startedAt || run.startedAt,
            })
        }
    }
    if (!runId) {
        throw new Error('GitHub ещё не создал запуск. Подождите несколько секунд и попробуйте снова.')
    }
    await client.cancelRun(runId)
    updateJobLocal(job.id, {
        status: 'abandoned',
        cancelRequested: true,
        processed: true,
        finishedAt: new Date().toISOString(),
        error: { code: 'cancelled', message: 'Задание отменено.' },
    })
    pushNotice('info', 'Задание отменено.')
}

export async function checkAudioUrl(url: string): Promise<{ ok: boolean; message: string; contentType: string }> {
    const api = requireApi()
    if (!isStableHttpsUrl(url)) return { ok: false, message: 'Ссылка должна быть постоянной HTTPS-ссылкой.', contentType: '' }
    try {
        const response = await api.net.fetch(url, {
            method: 'GET',
            headers: { Range: 'bytes=0-1023' },
            timeoutMs: 20000,
        })
        const contentType = response.headers.get('content-type') || ''
        if (response.status !== 200 && response.status !== 206) {
            return { ok: false, message: `HTTP ${response.status}`, contentType }
        }
        if (/text\/html/i.test(contentType)) {
            return { ok: false, message: 'Сервер вернул HTML-страницу, а не аудиофайл.', contentType }
        }
        return { ok: true, message: 'Файл доступен.', contentType }
    } catch (error) {
        return { ok: false, message: errorText(error), contentType: '' }
    }
}

export function jobSummary(job: JobRecord): string {
    return `${job.trackArtist ? `${job.trackArtist} — ` : ''}${job.trackTitle || `Трек ${job.trackId}`} · ${formatDateTime(job.createdAt)}`
}

export function replaceableTrackFromJob(job: JobRecord): TrackRef {
    return { id: job.trackId, title: job.trackTitle, artist: job.trackArtist }
}

export async function listReviewRequests() {
    if (!isRepositoryAdmin()) throw new Error('Заявки доступны только подтверждённому владельцу.')
    const revision = accessRevision
    const client = apiFor(requireApi())
    const requests: Array<{ number: number; title: string; requester: string; url: string; body: string }> = []
    for (let page = 1; ; page++) {
        const response = await client.request(`/repos/${client.repo}/issues?state=open&labels=uncensor-request&per_page=100&page=${page}`)
        const issues = await response.json() as Array<{
            number: number
            title?: string
            body?: string | null
            user?: { login?: string } | null
            pull_request?: unknown
            labels?: Array<string | { name?: string }>
        }>
        if (revision !== accessRevision || !active || !isRepositoryAdmin()) throw new Error('Вход владельца изменился. Обновите заявки.')
        for (const issue of issues) {
            const labels = (issue.labels || []).map(label => typeof label === 'string' ? label : label.name)
            if (issue.pull_request || labels.includes('uncensor-approved') || labels.includes('uncensor-rejected')) continue
            if (!Number.isSafeInteger(issue.number) || issue.number <= 0) continue
            requests.push({
                number: issue.number,
                title: sanitizeText(issue.title, 500) || `Заявка #${issue.number}`,
                requester: sanitizeText(issue.user?.login, 100) || 'неизвестен',
                url: `https://github.com/${client.repo}/issues/${issue.number}`,
                body: typeof issue.body === 'string' ? issue.body : '',
            })
        }
        if (issues.length < 100) return requests
    }
}

export async function reviewRequest(issueNumber: number, decision: 'approved' | 'rejected'): Promise<void> {
    if (!isRepositoryAdmin()) throw new Error('Решение может отправить только подтверждённый владелец.')
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0 || !['approved', 'rejected'].includes(decision)) {
        throw new Error('Некорректное решение по заявке.')
    }
    const revision = accessRevision
    const client = apiFor(requireApi())
    const access = await client.getAccessInfo()
    if (!access.canAdmin || revision !== accessRevision || !active || !isRepositoryAdmin()) {
        throw new Error('Вход владельца изменился. Войдите снова.')
    }
    const path = `/repos/${client.repo}/issues/${issueNumber}`
    const response = await client.request(path)
    const issue = await response.json() as { state?: string; pull_request?: unknown; labels?: Array<string | { name?: string }> }
    const labels = (issue.labels || []).map(label => typeof label === 'string' ? label : label.name)
    if (issue.state !== 'open' || issue.pull_request || !labels.includes('uncensor-request') ||
        labels.includes('uncensor-approved') || labels.includes('uncensor-rejected')) {
        throw new Error('Заявка уже рассмотрена или недоступна. Обновите список.')
    }
    if (revision !== accessRevision || !active || !isRepositoryAdmin()) throw new Error('Вход владельца изменился.')
    await client.request(`${path}/labels`, { method: 'POST', body: { labels: [`uncensor-${decision}`] } })
    if (revision !== accessRevision || !active || !isRepositoryAdmin()) throw new Error('Вход владельца изменился. Проверьте решение в GitHub.')
}
