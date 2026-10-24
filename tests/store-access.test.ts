import assert from 'node:assert/strict'
import test from 'node:test'
import type { AddonApi } from '@pulsesync/addon-sdk'
import { settings } from '../src/legacy/settings.ts'
import { SHARED_REPO } from '../src/legacy/constants.ts'
import {
    initialize, getState, isRepositoryAdmin, startSearch, confirmCandidate, pollPendingJobs,
    startAuthCheck, startBatchSearch, saveSetup, disconnectGitHub, refreshRepoAccess, removeMapping,
} from '../src/store.ts'

test('guest requests, owner identity, logout races and local hiding never grant repository write access', async () => {
    settings.set({ autoApply: false })
    const storage = new Map<string, unknown>()
    const remote = new Map<string, unknown>()
    const calls: Array<{ url: string; method: string }> = []
    const opened: string[] = []
    const cleanup: Array<() => void> = []
    let releaseLogin: (() => void) | undefined
    let delayLogin = false
    Object.assign(globalThis, { window: { open: (url: string) => { opened.push(url); return null } } })
    const api = {
        signal: new AbortController().signal,
        storage: {
            get: async (key: string) => storage.get(key),
            set: async (key: string, value: unknown) => { storage.set(key, value) },
            remove: async (key: string) => { storage.delete(key) },
        },
        setInterval: () => () => {},
        onCleanup: (callback: () => void) => { cleanup.push(callback) },
        notifications: { info: async () => {}, error: async () => {} },
        logger: { warn() {} },
        client: { removeTrackReplacement: async () => true, clearTrackReplacements: async () => {} },
        net: { fetch: async (url: string, options?: RequestInit) => {
            calls.push({ url, method: options?.method || 'GET' })
            if (url.includes('/jobs/')) {
                const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!.replace(/\.json$/, ''))
                return remote.has(id) ? Response.json(remote.get(id)) : new Response('', { status: 404 })
            }
            if (url.includes('/list.json')) return Response.json({ schema: 1, tracks: {
                '999': { trackId: '999', title: 'Existing', artists: ['Artist'], enabled: true,
                    audioUrl: 'https://github.com/owner/cloud/releases/download/library/999.m4a' },
            } })
            if (url.endsWith('/user')) {
                if (delayLogin) await new Promise<void>(resolve => { releaseLogin = resolve })
                return Response.json({ login: SHARED_REPO.split('/')[0] })
            }
            if (url.includes('/actions/workflows/')) return Response.json({ state: 'active', id: 1 })
            return Response.json({ full_name: SHARED_REPO, owner: { login: SHARED_REPO.split('/')[0] }, default_branch: 'main' })
        } },
    } as unknown as AddonApi
    try {
        await initialize(api)
        await new Promise(resolve => setTimeout(resolve, 0))
        assert.equal(getState().config?.repo, SHARED_REPO)
        assert.equal(isRepositoryAdmin(), false)
        const meta = { id: '123', title: 'Title', artist: 'Artist', durationMs: 180000 }
        const search = await startSearch(meta, meta, '', { auto: true })
        assert.equal(search.externalRequest, true)
        assert.equal(search.auto, false)
        assert.equal(opened.length, 1)
        assert.ok(search.requestUrl)
        const candidate = { id: 'candidate-1', provider: 'soundcloud', pageUrl: 'https://soundcloud.com/a/b',
            title: 'Title', artist: 'Artist', uploader: 'Artist', durationMs: 180000, score: 1, warnings: [] }
        remote.set(search.id, { ...search, requestUrl: undefined, status: 'ready', candidates: [candidate], issueNumber: 1,
            issueUrl: `https://github.com/${SHARED_REPO}/issues/1` })
        await pollPendingJobs()
        const ready = getState().jobs.find(job => job.id === search.id)!
        assert.equal(ready.status, 'ready')
        const request = await confirmCandidate(ready, ready.candidates![0])
        assert.equal(request.externalRequest, true)
        remote.set(request.id, { ...request, status: 'awaiting_approval', issueNumber: 2,
            issueUrl: `https://github.com/${SHARED_REPO}/issues/2` })
        await pollPendingJobs()
        assert.equal(getState().jobs.find(job => job.id === request.id)?.status, 'awaiting_approval')
        remote.set(request.id, { ...request, status: 'failed', error: { code: 'rejected', message: 'Owner rejected' } })
        await pollPendingJobs()
        assert.equal(getState().jobs.find(job => job.id === request.id)?.error?.code, 'rejected')
        await removeMapping('999')
        assert.ok(getState().removed.includes('999'))
        await assert.rejects(() => startAuthCheck(), /владельц/)
        await assert.rejects(() => startBatchSearch([]), /владельц/)
        assert.ok(calls.every(call => call.method === 'GET'))
        assert.ok(!calls.some(call => call.url.includes('/dispatches')))
        await saveSetup({ repo: SHARED_REPO, token: 'synthetic-owner-token', rememberToken: false })
        assert.equal(isRepositoryAdmin(), true)
        delayLogin = true
        const access = refreshRepoAccess()
        while (!releaseLogin) await new Promise(resolve => setTimeout(resolve, 0))
        await disconnectGitHub(false)
        releaseLogin()
        await access
        assert.equal(isRepositoryAdmin(), false)
        assert.equal(getState().repoInfo, null)
    } finally {
        for (const callback of cleanup) callback()
    }
})
