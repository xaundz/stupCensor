import assert from 'node:assert/strict'
import test from 'node:test'
import type { AddonApi } from '@pulsesync/addon-sdk'
import type { JobRecord } from '../src/types.ts'
import { settings } from '../src/legacy/settings.ts'
import { SHARED_REPO } from '../src/legacy/constants.ts'
import {
    initialize, getState, isRepositoryAdmin, startSearch, confirmCandidate, pollPendingJobs,
    startAuthCheck, startBatchSearch, saveSetup, disconnectGitHub, refreshRepoAccess, removeMapping,
    refreshLibrary, refreshJob, isRepositoryOwner, setTestAsUser,
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
        assert.throws(() => setTestAsUser(true), /владельц/)
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
        setTestAsUser(true)
        assert.equal(isRepositoryOwner(), true)
        assert.equal(isRepositoryAdmin(), false)
        assert.equal(getState().hasToken, true)
        await assert.rejects(() => startAuthCheck(), /владельц/)
        const simulated = await startSearch({ ...meta, id: '124' }, { ...meta, id: '124' }, '')
        assert.equal(simulated.externalRequest, true)
        assert.ok(calls.every(call => call.method === 'GET'))
        setTestAsUser(false)
        assert.equal(isRepositoryAdmin(), true)
        delayLogin = true
        const access = refreshRepoAccess()
        while (!releaseLogin) await new Promise(resolve => setTimeout(resolve, 0))
        await disconnectGitHub(false)
        releaseLogin()
        await access
        assert.equal(isRepositoryAdmin(), false)
        assert.equal(getState().repoInfo, null)
        assert.equal(getState().testAsUser, false)
    } finally {
        for (const callback of cleanup) callback()
    }
})

test('owner deletion, authoritative publication, refresh races and bounded polling', async () => {
    settings.set({ autoApply: true })
    const storage = new Map<string, unknown>()
    const cleanup: Array<() => void> = []
    const registered = new Map<string, string>()
    const reloaded: string[] = []
    const remote = new Map<string, unknown>()
    const calls: Array<{ url: string; authorization?: string }> = []
    const asset = (name: string) => `https://github.com/${SHARED_REPO}/releases/download/library/${name}.m4a`
    const mapping = (id: string, name: string) => ({ trackId: id, title: name, artists: ['Artist'],
        enabled: true, audioUrl: asset(name), assetName: `${name}.m4a` })
    let tracks: Record<string, ReturnType<typeof mapping>> = { '123': mapping('123', 'old'), '999': mapping('999', 'keep') }
    let delayedIndex: Promise<void> | null = null
    let releaseIndex: (() => void) | undefined
    let indexStarted = false
    let jobGate: Promise<void> | null = null
    let releaseJobs: (() => void) | undefined
    let concurrent = 0
    let maxConcurrent = 0
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
        client: {
            setTrackReplacement: async (id: string, url: string) => { registered.set(id, url); return true },
            setTrackReplacements: async (items: Record<string, string>) => { for (const [id, url] of Object.entries(items)) registered.set(id, url) },
            removeTrackReplacement: async (id: string) => registered.delete(id),
            clearTrackReplacements: async () => { registered.clear() },
            getCurrentTrack: async () => ({ id: '123' }),
            reloadPlayer: async (id: string) => { reloaded.push(id); return true },
        },
        net: { fetch: async (url: string, options?: RequestInit) => {
            calls.push({ url, authorization: (options?.headers as Record<string, string> | undefined)?.Authorization })
            if (url.includes('/jobs/')) {
                concurrent++
                maxConcurrent = Math.max(maxConcurrent, concurrent)
                await jobGate
                concurrent--
                const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!.replace(/\.json$/, ''))
                return remote.has(id) ? Response.json(remote.get(id)) : Response.json({ status: 'running' })
            }
            if (url.includes('/list.json')) {
                const snapshot = structuredClone(tracks)
                indexStarted = true
                await delayedIndex
                return Response.json({ schema: 1, tracks: snapshot })
            }
            if (url.endsWith('/user')) return Response.json({ login: SHARED_REPO.split('/')[0] })
            if (url.endsWith('/dispatches')) return new Response(null, { status: 204 })
            if (url.includes('/actions/workflows/')) return Response.json({ state: 'active', id: 1 })
            return Response.json({ full_name: SHARED_REPO, owner: { login: SHARED_REPO.split('/')[0] }, default_branch: 'main' })
        } },
    } as unknown as AddonApi
    try {
        await initialize(api)
        await new Promise(resolve => setTimeout(resolve, 0))
        await saveSetup({ repo: SHARED_REPO, token: 'synthetic-owner-token', rememberToken: false })
        assert.equal(registered.get('123'), asset('old'))
        assert.ok(calls.some(call => call.url.includes('/contents/list.json') && call.authorization))
        await removeMapping('123')
        assert.equal(registered.has('123'), false)
        assert.deepEqual(reloaded, ['123'])
        assert.ok(getState().removed.includes('123'))
        assert.ok(getState().library.tracks['123'], 'cloud deletion must not be claimed before completion')
        const removal = getState().jobs.find(job => job.action === 'remove')!

        indexStarted = false
        delayedIndex = new Promise(resolve => { releaseIndex = resolve })
        const earlier = refreshLibrary({ silent: true })
        while (!indexStarted) await new Promise(resolve => setTimeout(resolve, 0))
        remote.set(removal.id, { status: 'removed', removedAudioUrl: asset('old') })
        const completedRemoval = refreshJob(removal.id)
        await new Promise(resolve => setTimeout(resolve, 0))
        delayedIndex = null
        releaseIndex!()
        await Promise.all([earlier, completedRemoval])
        assert.equal(getState().library.tracks['123'], undefined, 'stale deletion index cannot reinsert old mapping')
        assert.equal(registered.has('123'), false)
        assert.ok(getState().library.tracks['999'], 'unrelated mappings survive')
        const cached = storage.get('stupidcensor.library-cache.v1') as { index: { tracks: Record<string, unknown> } }
        assert.equal(cached.index.tracks['123'], undefined)
        await refreshLibrary({ silent: true })
        assert.equal(getState().library.tracks['123'], undefined)

        const meta = { id: '123', title: 'Title', artist: 'Artist', durationMs: 180000 }
        const source = await startSearch(meta, meta, '')
        const candidate = { id: 'selected-youtube', provider: 'youtube' as const, pageUrl: 'https://www.youtube.com/watch?v=selected',
            title: 'Title', artist: 'Artist', uploader: 'Artist', durationMs: 180000, score: 1, warnings: [] }
        source.candidates = [candidate]
        const publication = await confirmCandidate(source, candidate)
        assert.equal(publication.candidateId, candidate.id)
        remote.set(publication.id, { status: 'published', published: { audioUrl: asset('new'), assetName: 'new.m4a' } })
        await refreshJob(publication.id)
        assert.equal(getState().notice?.kind, 'error')
        assert.match(getState().notice!.text, /библиотека не обновилась/)
        assert.equal(registered.has('123'), false)
        assert.ok(getState().removed.includes('123'))
        assert.ok(!getState().jobs.find(job => job.id === publication.id)?.processed)
        tracks = { ...tracks, '123': mapping('123', 'new') }
        await refreshJob(publication.id)
        assert.equal(registered.get('123'), asset('new'))
        assert.equal(getState().removed.includes('123'), false)
        assert.equal(getState().notice?.kind, 'success')

        // A coalesced refresh must wait for network completion, not return cached state.
        indexStarted = false
        delayedIndex = new Promise(resolve => { releaseIndex = resolve })
        const first = refreshLibrary({ silent: true })
        while (!indexStarted) await new Promise(resolve => setTimeout(resolve, 0))
        let settled = false
        const second = refreshLibrary({ silent: true }).then(result => { settled = true; return result })
        await new Promise(resolve => setTimeout(resolve, 0))
        assert.equal(settled, false)
        tracks = { ...tracks, '123': mapping('123', 'latest') }
        const forced = refreshLibrary({ silent: true, force: true })
        delayedIndex = null
        releaseIndex!()
        assert.equal(await first, null)
        await second
        await forced
        assert.equal(registered.get('123'), asset('latest'))

        for (const id of ['201', '202', '203', '204']) await startSearch({ ...meta, id }, { ...meta, id }, '')
        jobGate = new Promise(resolve => { releaseJobs = resolve })
        const polling = pollPendingJobs()
        while (concurrent < 3) await new Promise(resolve => setTimeout(resolve, 0))
        assert.equal(maxConcurrent, 3)
        jobGate = null
        releaseJobs!()
        await polling
        assert.equal(maxConcurrent, 3)

        indexStarted = false
        delayedIndex = new Promise(resolve => { releaseIndex = resolve })
        tracks = { ...tracks, '123': mapping('123', 'logged-out-stale') }
        const logoutRefresh = refreshLibrary({ silent: true })
        while (!indexStarted) await new Promise(resolve => setTimeout(resolve, 0))
        await disconnectGitHub(false)
        releaseIndex!()
        await logoutRefresh
        assert.equal(getState().library.tracks['123']?.audioUrl, asset('latest'))
        assert.equal(registered.get('123'), asset('latest'))
    } finally {
        releaseIndex?.()
        releaseJobs?.()
        for (const callback of cleanup) callback()
        settings.set({ autoApply: false })
    }
})

test('same-track terminal outcomes preserve newer mappings and serialize duplicate effects', async () => {
    settings.set({ autoApply: true })
    const asset = (name: string) => `https://github.com/${SHARED_REPO}/releases/download/library/${name}.m4a`
    const time = (second: number) => `2026-10-24T00:00:${String(second).padStart(2, '0')}.000Z`
    const mapping = (name: string, second?: number) => ({ trackId: '123', title: name, artists: ['Artist'],
        audioUrl: asset(name), assetName: `${name}.m4a`, updatedAt: second === undefined ? '' : time(second) })
    let tracks: Record<string, ReturnType<typeof mapping>> = { '123': mapping('A', 0) }
    const ids = ['publish-A', 'publish-B', 'old-remove', 'different-remove', 'empty-remove', 'timestamp-remove',
        'legacy-remove', 'later-delete', 'absent-publish', 'duplicate-publish', 'publish-X', 'remove-X', 'publish-Y']
    const jobs: JobRecord[] = ids.map(id => ({ id, action: id.includes('publish') ? 'manual' : 'remove', status: 'queued',
        repo: SHARED_REPO, branch: 'main', trackId: '123', trackTitle: id, trackArtist: 'Artist',
        createdAt: new Date().toISOString(), updatedAt: '2099-01-01T00:00:00.000Z' }))
    const storage = new Map<string, unknown>([
        ['stupidcensor.config.v1', { repo: SHARED_REPO, branch: 'main', rememberToken: true }],
        ['stupidcensor.token.v1', 'synthetic-owner-token'],
        ['stupidcensor.jobs.v1', jobs],
    ])
    const remote = new Map<string, Record<string, unknown>>()
    const registered = new Map<string, string>()
    const effects: string[] = []
    const notices: string[] = []
    const cleanup: Array<() => void> = []
    let indexReads = 0
    const api = {
        signal: new AbortController().signal,
        storage: {
            get: async (key: string) => storage.get(key),
            set: async (key: string, value: unknown) => { storage.set(key, value) },
            remove: async (key: string) => { storage.delete(key) },
        },
        setInterval: () => () => {},
        onCleanup: (callback: () => void) => { cleanup.push(callback) },
        notifications: { info: async (text: string) => { notices.push(text) }, error: async (text: string) => { notices.push(text) } },
        logger: { warn() {} },
        client: {
            setTrackReplacement: async (id: string, url: string) => { effects.push(`apply:${url}`); registered.set(id, url); return true },
            setTrackReplacements: async (items: Record<string, string>) => {
                effects.push('apply-library')
                for (const [id, url] of Object.entries(items)) registered.set(id, url)
            },
            removeTrackReplacement: async (id: string) => { effects.push('remove'); return registered.delete(id) },
            clearTrackReplacements: async () => { effects.push('clear'); registered.clear() },
            getCurrentTrack: async () => ({ id: '123' }),
            reloadPlayer: async () => { effects.push('reload'); return true },
        },
        net: { fetch: async (url: string) => {
            if (url.includes('/jobs/')) {
                const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!.replace(/\.json$/, ''))
                return Response.json(remote.get(id) || { status: 'running' })
            }
            if (url.includes('/list.json')) { indexReads++; return Response.json({ schema: 1, tracks }) }
            if (url.endsWith('/user')) return Response.json({ login: SHARED_REPO.split('/')[0] })
            if (url.includes('/actions/workflows/')) return Response.json({ state: 'active', id: 1 })
            return Response.json({ full_name: SHARED_REPO, owner: { login: SHARED_REPO.split('/')[0] }, default_branch: 'main' })
        } },
    } as unknown as AddonApi
    const published = (name: string, second: number) => ({ status: 'published', updatedAt: time(second),
        published: { audioUrl: asset(name), assetName: `${name}.m4a` } })
    const processed = (id: string) => getState().jobs.find(job => job.id === id)!.processed
    try {
        await initialize(api)
        await new Promise(resolve => setTimeout(resolve, 0))
        effects.length = 0
        const notice = getState().notice
        // The cached mapping is A, but the authoritative index has B newer than A's completion.
        tracks = { '123': mapping('B', 2) }
        remote.set('publish-A', published('A', 1))
        await refreshJob('publish-A')
        assert.equal(processed('publish-A'), true)
        assert.equal(getState().library.tracks['123']?.audioUrl, asset('B'))
        assert.deepEqual(effects, [], 'superseded publication must not apply or reload the player')
        assert.equal(getState().notice, notice)
        assert.deepEqual(notices, [])

        remote.set('publish-B', published('B', 2))
        await refreshJob('publish-B')
        assert.equal(registered.get('123'), asset('B'))
        effects.length = 0

        remote.set('old-remove', { status: 'removed', removedAudioUrl: asset('A'), updatedAt: time(1) })
        remote.set('different-remove', { status: 'removed', removedAudioUrl: asset('A') })
        remote.set('empty-remove', { status: 'removed', removedAudioUrl: '' })
        remote.set('timestamp-remove', { status: 'removed', removedAudioUrl: asset('B'), finishedAt: time(1) })
        for (const id of ['old-remove', 'different-remove', 'empty-remove', 'timestamp-remove']) {
            await refreshJob(id)
            assert.equal(processed(id), true)
            assert.equal(getState().library.tracks['123']?.audioUrl, asset('B'))
        }
        assert.equal(getState().jobs.find(job => job.id === 'empty-remove')?.removedAudioUrl, '')
        assert.deepEqual(effects, [], 'old removals must not tombstone, unregister or reload a newer mapping')
        await refreshLibrary({ silent: true })
        assert.equal(registered.get('123'), asset('B'), 'new mapping was not tombstoned')

        tracks = { '123': mapping('C') }
        remote.set('legacy-remove', { status: 'removed' })
        effects.length = 0
        const reads = indexReads
        await refreshJob('legacy-remove')
        assert.ok(indexReads > reads, 'legacy removal must reconcile the index')
        assert.equal(getState().jobs.find(job => job.id === 'legacy-remove')?.removedAudioUrl, undefined)
        assert.equal(registered.get('123'), asset('C'))
        assert.equal(effects.includes('remove'), false)
        assert.equal(effects.includes('reload'), false)

        tracks = {}
        remote.set('later-delete', { status: 'removed', removedAudioUrl: asset('C'), updatedAt: time(4) })
        await refreshJob('later-delete')
        remote.set('absent-publish', published('B', 3))
        effects.length = 0
        const readsAfterDelete = indexReads
        const noticeAfterDelete = getState().notice
        await refreshJob('absent-publish')
        await refreshJob('absent-publish')
        assert.equal(processed('absent-publish'), true, 'later deletion supersedes publication even with no mapping')
        assert.equal(indexReads, readsAfterDelete, 'superseded publication must not retry index fetches')
        assert.equal(getState().library.tracks['123'], undefined)
        assert.deepEqual(effects, [])
        assert.equal(getState().notice, noticeAfterDelete)

        tracks = { '123': mapping('D', 5) }
        remote.set('duplicate-publish', published('D', 5))
        await Promise.all([refreshJob('duplicate-publish'), refreshJob('duplicate-publish')])
        assert.equal(effects.filter(item => item === `apply:${asset('D')}`).length, 1)
        assert.equal(effects.filter(item => item === 'reload').length, 1)
        assert.equal(processed('duplicate-publish'), true)

        tracks = { '123': mapping('Y', 8) }
        remote.set('publish-X', published('X', 6))
        remote.set('remove-X', { status: 'removed', removedAudioUrl: asset('X'), updatedAt: time(7) })
        remote.set('publish-Y', published('Y', 8))
        effects.length = 0
        await pollPendingJobs()
        for (const id of ['publish-X', 'remove-X', 'publish-Y']) assert.equal(processed(id), true)
        assert.equal(registered.get('123'), asset('Y'))
        assert.equal(getState().library.tracks['123']?.audioUrl, asset('Y'))
        assert.equal(effects.includes('remove'), false)
        assert.equal(effects.filter(item => item === 'reload').length, 1)
        assert.equal(effects.filter(item => item.startsWith('apply:')).length, 1)
    } finally {
        for (const callback of cleanup) callback()
        settings.set({ autoApply: false })
    }
})
