import type { AddonApi } from '@pulsesync/addon-sdk'

import type { JobRecord, LibraryIndex, RepoInfo, SetupResult, WorkflowInfo, WorkflowRun } from '../types.ts'
import { parseIndex } from './library.ts'

export const WORKFLOW_FILE = 'uncensor-cloud.yml'
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`
const API_BASE = 'https://api.github.com'
const API_VERSION = '2022-11-28'

export class GitHubError extends Error {
    readonly status: number
    readonly code: string

    constructor(message: string, status = 0, code = 'github_error') {
        super(message)
        this.name = 'GitHubError'
        this.status = status
        this.code = code
    }
}

type RequestOptions = {
    method?: string
    body?: unknown
    accept?: string
    token?: string
    timeoutMs?: number
    base?: string
}

export class GitHubClient {
    readonly repo: string
    readonly token: string
    readonly branch: string
    private readonly api: AddonApi

    constructor(api: AddonApi, repo: string, token: string, branch = '') {
        this.api = api
        this.repo = repo
        this.token = token
        this.branch = branch
    }

    private headers(options: RequestOptions): Record<string, string> {
        const headers: Record<string, string> = {
            Accept: options.accept ?? 'application/vnd.github+json',
            'X-GitHub-Api-Version': API_VERSION,
        }
        if (options.body !== undefined && !(options.body instanceof Uint8Array)) {
            headers['Content-Type'] = 'application/json'
        }
        if (this.token) headers.Authorization = `Bearer ${this.token}`
        return headers
    }

    async request(path: string, options: RequestOptions = {}): Promise<Response> {
        const url = `${options.base ?? API_BASE}${path}`
        let response: Response
        try {
            response = await this.api.net.fetch(url, {
                method: options.method ?? 'GET',
                headers: this.headers(options),
                ...(options.body !== undefined
                    ? {
                          body:
                              options.body instanceof Uint8Array
                                  ? (options.body as unknown as BodyInit)
                                  : JSON.stringify(options.body),
                      }
                    : {}),
                timeoutMs: options.timeoutMs ?? 20000,
            })
        } catch (error) {
            throw new GitHubError(
                `Не удалось связаться с GitHub: ${error instanceof Error ? error.message : String(error)}`,
                0,
                'network',
            )
        }
        if (response.ok) return response
        throw await this.toError(response)
    }

    private async toError(response: Response): Promise<GitHubError> {
        let message = ''
        try {
            const data = (await response.json()) as { message?: unknown; documentation_url?: unknown }
            if (typeof data.message === 'string') message = data.message
        } catch {
            message = ''
        }
        const rateRemaining = response.headers.get('x-ratelimit-remaining')
        const rateReset = Number(response.headers.get('x-ratelimit-reset') || 0)
        if (response.status === 401) {
            return new GitHubError('GitHub отклонил токен: он недействителен или истёк.', 401, 'bad_token')
        }
        if (response.status === 403 && (rateRemaining === '0' || /rate limit/i.test(message))) {
            const reset = rateReset ? new Date(rateReset * 1000).toLocaleTimeString('ru-RU') : ''
            return new GitHubError(
                `Исчерпан лимит GitHub API${reset ? ` до ${reset}` : ''}. Подождите или проверьте токен.`,
                403,
                'rate_limit',
            )
        }
        if (response.status === 403) {
            return new GitHubError(
                'GitHub запретил действие. Проверьте права токена: Contents (Read and write) и Actions (Read and write).',
                403,
                'forbidden',
            )
        }
        if (response.status === 404) {
            return new GitHubError('GitHub: объект не найден. Проверьте имя репозитория, ветку и workflow.', 404, 'not_found')
        }
        if (response.status === 422 && message) {
            return new GitHubError(`GitHub отклонил запрос: ${message}`, 422, 'unprocessable')
        }
        return new GitHubError(
            `GitHub API: HTTP ${response.status}${message ? ` — ${message}` : ''}`,
            response.status,
            'http_error',
        )
    }

    async getRepo(): Promise<RepoInfo> {
        const response = await this.request(`/repos/${this.repo}`)
        const data = (await response.json()) as {
            full_name?: string
            private?: boolean
            default_branch?: string
            html_url?: string
            permissions?: { push?: boolean }
        }
        return {
            fullName: String(data.full_name || this.repo),
            private: data.private === true,
            defaultBranch: String(data.default_branch || 'main'),
            htmlUrl: String(data.html_url || `https://github.com/${this.repo}`),
            canPush: data.permissions?.push,
        }
    }

    async getWorkflow(): Promise<WorkflowInfo> {
        try {
            const response = await this.request(`/repos/${this.repo}/actions/workflows/${WORKFLOW_FILE}`)
            const data = (await response.json()) as {
                id?: number
                name?: string
                path?: string
                state?: string
                html_url?: string
            }
            return {
                id: Number(data.id) || 0,
                name: String(data.name || 'stupidCensor'),
                path: String(data.path || WORKFLOW_PATH),
                state: String(data.state || 'unknown'),
                htmlUrl: String(data.html_url || `https://github.com/${this.repo}/actions`),
            }
        } catch (error) {
            if (!(error instanceof GitHubError) || error.status !== 404) throw error
            const exists = await this.fileExists(WORKFLOW_PATH)
            if (exists) {
                throw new GitHubError(
                    'Workflow есть в репозитории, но GitHub Actions его не видит. Проверьте, что Actions включены во вкладке Actions.',
                    404,
                    'actions_disabled',
                )
            }
            throw new GitHubError(
                `В репозитории нет ${WORKFLOW_PATH}. Скопируйте папку .github из архива в корень репозитория.`,
                404,
                'workflow_missing',
            )
        }
    }

    async verifySetup(): Promise<SetupResult> {
        const repo = await this.getRepo()
        if (repo.private) {
            throw new GitHubError(
                'Репозиторий приватный. Прямые ссылки на аудио должны открываться без авторизации, поэтому нужен публичный репозиторий.',
                422,
                'private_repo',
            )
        }
        const workflow = await this.getWorkflow()
        if (workflow.state !== 'active') {
            throw new GitHubError(
                `Workflow «${workflow.name}» не активен (${workflow.state}). Включите Actions в настройках репозитория.`,
                422,
                'workflow_inactive',
            )
        }
        return { repo, workflow }
    }

    private async fileExists(path: string): Promise<boolean> {
        try {
            await this.request(`/repos/${this.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}${this.refQuery()}`)
            return true
        } catch (error) {
            if (error instanceof GitHubError && error.status === 404) return false
            throw error
        }
    }

    private refQuery(): string {
        return this.branch ? `?ref=${encodeURIComponent(this.branch)}` : ''
    }

    async getIndex(): Promise<LibraryIndex | null> {
        if (!this.token) return this.getPublicIndex()
        try {
            const response = await this.request(
                `/repos/${this.repo}/contents/list.json${this.refQuery()}`,
                { accept: 'application/vnd.github.raw+json', timeoutMs: 20000 },
            )
            const text = await response.text()
            return parseIndex(JSON.parse(text))
        } catch (error) {
            if (error instanceof GitHubError && error.status === 404) return null
            throw error
        }
    }

    async getPublicIndex(): Promise<LibraryIndex | null> {
        const branch = this.branch || 'main'
        const url = `https://raw.githubusercontent.com/${this.repo}/${encodeURIComponent(branch)}/list.json?t=${Date.now()}`
        let response: Response
        try {
            response = await this.api.net.fetch(url, { timeoutMs: 20000 })
        } catch (error) {
            throw new GitHubError(
                `Не удалось загрузить list.json: ${error instanceof Error ? error.message : String(error)}`,
                0,
                'network',
            )
        }
        if (response.status === 404) return null
        if (!response.ok) {
            throw new GitHubError(`list.json: HTTP ${response.status}`, response.status, 'index_http')
        }
        return parseIndex(JSON.parse(await response.text()))
    }

    async dispatch(action: JobRecord['action'], inputs: Record<string, string>): Promise<void> {
        if (!this.token) {
            throw new GitHubError('Для запуска задания нужен GitHub-токен.', 401, 'token_required')
        }
        await this.request(`/repos/${this.repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
            method: 'POST',
            body: {
                ref: this.branch,
                inputs: { action, ...inputs },
            },
            timeoutMs: 25000,
        })
    }

    async getJob(jobId: string): Promise<Record<string, unknown> | null> {
        try {
            const response = await this.request(
                `/repos/${this.repo}/contents/jobs/${encodeURIComponent(jobId)}.json${this.refQuery()}`,
                { accept: 'application/vnd.github.raw+json', timeoutMs: 15000 },
            )
            return JSON.parse(await response.text()) as Record<string, unknown>
        } catch (error) {
            if (error instanceof GitHubError && error.status === 404) return null
            throw error
        }
    }

    async getRunForJob(jobId: string): Promise<WorkflowRun | null> {
        try {
            const response = await this.request(
                `/repos/${this.repo}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=40${this.branch ? `&branch=${encodeURIComponent(this.branch)}` : ''}`,
                { timeoutMs: 15000 },
            )
            const data = (await response.json()) as {
                workflow_runs?: Array<{
                    id?: number
                    status?: string
                    conclusion?: string | null
                    html_url?: string
                    display_title?: string
                    name?: string
                    run_started_at?: string | null
                }>
            }
            const run = (data.workflow_runs ?? []).find(item =>
                `${item.display_title || ''} ${item.name || ''}`.includes(jobId),
            )
            if (!run) return null
            return {
                id: Number(run.id) || 0,
                status: String(run.status || 'unknown'),
                conclusion: run.conclusion ?? null,
                htmlUrl: String(run.html_url || ''),
                displayTitle: String(run.display_title || ''),
                startedAt: run.run_started_at ? String(run.run_started_at) : undefined,
            }
        } catch (error) {
            this.api.logger.warn('Не удалось получить статус запуска Actions', error)
            return null
        }
    }

    async cancelRun(runId: number): Promise<void> {
        if (!this.token) {
            throw new GitHubError('Для отмены задания нужен GitHub-токен.', 401, 'token_required')
        }
        await this.request(`/repos/${this.repo}/actions/runs/${runId}/cancel`, {
            method: 'POST',
            timeoutMs: 20000,
        })
    }

    async getTokenLogin(): Promise<string> {
        const response = await this.request('/user', { timeoutMs: 15000 })
        const data = (await response.json()) as { login?: string }
        return String(data.login || '')
    }
}

export function createClient(api: AddonApi, repo: string, token: string, branch: string): GitHubClient {
    return new GitHubClient(api, repo, token, branch)
}
