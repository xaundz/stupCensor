import assert from 'node:assert/strict'
import test from 'node:test'
import type { AddonApi } from '@pulsesync/addon-sdk'
import type { JobRecord } from '../src/types.ts'
import { buildRequestUrl } from '../src/lib/requests.ts'
import { GitHubClient } from '../src/lib/github.ts'

const job: JobRecord = {
    id: 'test-job', action: 'search', status: 'queued', repo: 'owner/cloud', branch: 'main',
    trackId: '123', trackTitle: 'Title', trackArtist: 'Artist', trackDurationMs: 180400,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
}

test('browser intake body matches the exact contract', () => {
    const url = new URL(buildRequestUrl(job))
    assert.equal(url.pathname, '/owner/cloud/issues/new')
    assert.equal(url.searchParams.get('body'), 'stupidcensor-request-v1\n```json\n' + JSON.stringify({
        id: 'test-job', action: 'search', trackId: '123', title: 'Title', artist: 'Artist', duration: 180,
    }) + '\n```')
    assert.ok(url.href.length <= 6000)
    const confirm = new URL(buildRequestUrl({ ...job, action: 'confirm', sourceJobId: 'source', candidateId: 'candidate' }))
    assert.ok(confirm.searchParams.get('body')?.includes('"sourceJobId":"source","candidateId":"candidate"'))
})

test('drafts reject credentials and oversized URLs and sanitize text', () => {
    for (const source of ['https://user:pass@example.com/a', 'https://example.com/a?token=secret',
        'https://example.com/a?api_key=secret', 'https://example.com/' + 'a'.repeat(2000)]) {
        assert.throws(() => buildRequestUrl(job, source))
    }
    const url = buildRequestUrl({ ...job, trackTitle: '```\n ghp_secretvalue' })
    assert.ok(!decodeURIComponent(url).includes('ghp_secretvalue'))
    assert.throws(() => buildRequestUrl({ ...job, trackTitle: '\u4e00'.repeat(200), trackArtist: '\u4e00'.repeat(200) }), /6000/)
})

function mockApi(fetch: (url: string, options?: { headers?: Record<string, string> }) => Promise<Response>): AddonApi {
    return { net: { fetch }, logger: { warn() {} } } as unknown as AddonApi
}

test('only the authenticated canonical owner is admin, never a collaborator', async () => {
    for (const viewer of ['Owner', 'collaborator', '']) {
        const client = new GitHubClient(mockApi(async url => {
            if (url.endsWith('/user')) return Response.json({ login: viewer })
            return Response.json({ full_name: 'owner/cloud', owner: { login: 'owner' }, permissions: { admin: true } })
        }), 'owner/cloud', 'test-token', 'main')
        assert.equal((await client.getAccessInfo()).canAdmin, viewer === 'Owner')
    }
    const failed = new GitHubClient(mockApi(async url => url.endsWith('/user')
        ? new Response('', { status: 401 })
        : Response.json({ full_name: 'owner/cloud', permissions: { admin: true } })), 'owner/cloud', 'test-token')
    await assert.rejects(() => failed.getAccessInfo(), /токен/)
})

test('public job and index reads use raw without authorization', async () => {
    const calls: string[] = []
    const client = new GitHubClient(mockApi(async (url, options) => {
        calls.push(url)
        assert.equal(options?.headers?.Authorization, undefined)
        assert.ok(url.startsWith('https://raw.githubusercontent.com/owner/cloud/main/'))
        return url.includes('/jobs/') ? Response.json({ status: 'ready' }) : Response.json({ schema: 1, tracks: {} })
    }), 'owner/cloud', '', 'main')
    assert.equal((await client.getJob('test-job'))?.status, 'ready')
    assert.ok(await client.getIndex())
    assert.equal(calls.length, 2)
})

test('ordinary setup does not request workflow access or dispatch Actions', async () => {
    const calls: string[] = []
    const client = new GitHubClient(mockApi(async url => {
        calls.push(url)
        return url.endsWith('/user') ? Response.json({ login: 'guest' }) : Response.json({ full_name: 'owner/cloud' })
    }), 'owner/cloud', 'test-token')
    assert.equal((await client.verifySetup()).workflow, null)
    await assert.rejects(() => client.dispatch('search', {}), /подтверждённый владелец/)
    assert.ok(calls.every(url => !url.includes('/actions/')))
})
