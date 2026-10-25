import assert from 'node:assert/strict'
import test from 'node:test'
import sodium from 'libsodium-wrappers'
import type { AddonApi } from '@pulsesync/addon-sdk'
import { COOKIE_FILE_LIMIT, encryptCookies, normalizeYoutubeCookies } from '../src/lib/cookies.ts'
import { initialize, saveSetup, saveYoutubeCookies, saveYoutubeProxy, setTestAsUser } from '../src/store.ts'
import { settings } from '../src/legacy/settings.ts'
import { SHARED_REPO } from '../src/legacy/constants.ts'

const row = '.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\tsynthetic-youtube-session'
const cookies = '# Netscape HTTP Cookie File\n' + row + '\n'

test('cookie import preserves tabs, HTTP-only and empty values but excludes other websites', () => {
    const text = '\uFEFF# Netscape HTTP Cookie File\r\n' + row + '\r\n' +
        '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tempty\t\r\n' +
        '.google.com\tTRUE\t/\tTRUE\t0\tSID\tsynthetic-google-session\r\n' +
        '.youtube.com.evil.test\tTRUE\t/\tTRUE\t0\tSID\tsynthetic-other-session\r\n'
    const result = normalizeYoutubeCookies(text)
    assert.ok(result.includes(row))
    assert.ok(result.includes('0\tempty\t\n'))
    assert.ok(result.includes('#HttpOnly_.youtube.com'))
    assert.ok(!result.includes('google-session'))
    assert.ok(!result.includes('other-session'))
})

test('cookie import rejects invalid, expired, missing YouTube or oversized data without echoing input', () => {
    for (const text of ['synthetic-private-value', '{"SID":"synthetic-private-value"}',
        '# Netscape HTTP Cookie File\ninvalid\tsecret',
        '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1\tSID\texpired',
        '# Netscape HTTP Cookie File\n.google.com\tTRUE\t/\tTRUE\t0\tSID\tprivate',
        '# Netscape HTTP Cookie File\n' + row + '\0', 'x'.repeat(COOKIE_FILE_LIMIT + 1)]) {
        assert.throws(() => normalizeYoutubeCookies(text), error => {
            assert.ok(error instanceof Error)
            assert.ok(!error.message.includes('synthetic-private-value'))
            assert.ok(!error.message.includes('\tsecret'))
            return true
        })
    }
})

test('sealed-box encryption is decryptable only with the generated private key', async () => {
    await sodium.ready
    const keys = sodium.crypto_box_keypair()
    const encrypted = await encryptCookies(cookies, sodium.to_base64(keys.publicKey, sodium.base64_variants.ORIGINAL))
    assert.ok(!encrypted.includes('synthetic-youtube-session'))
    const decrypted = sodium.crypto_box_seal_open(
        sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL), keys.publicKey, keys.privateKey,
    )
    assert.equal(sodium.to_string(decrypted), cookies)
    sodium.memzero(keys.privateKey)
    sodium.memzero(decrypted)
    await assert.rejects(() => encryptCookies(cookies, 'bad-key'), /зашифровать/)
})

test('owner secret upload sends ciphertext only and rejects guests, denied permissions and scope changes', async () => {
    await sodium.ready
    settings.set({ autoApply: false })
    const keys = sodium.crypto_box_keypair()
    const storage = new Map<string, unknown>()
    const writes: Array<{ url: string; body: Record<string, string> }> = []
    const cleanup: Array<() => void> = []
    let permissionDenied = false
    let delayedKey = false
    let releaseKey: (() => void) | undefined
    const api = {
        signal: new AbortController().signal,
        storage: {
            get: async (key: string) => storage.get(key),
            set: async (key: string, value: unknown) => { storage.set(key, value) },
            remove: async (key: string) => { storage.delete(key) },
        },
        onCleanup: (callback: () => void) => { cleanup.push(callback) },
        setInterval: () => () => {},
        notifications: { info: async () => {}, error: async () => {} },
        client: { clearTrackReplacements: async () => {} },
        logger: { warn() {} },
        net: { fetch: async (url: string, options?: RequestInit) => {
            if (url.endsWith('/public-key')) {
                if (permissionDenied) return Response.json({ message: 'Forbidden' }, { status: 403 })
                if (delayedKey) await new Promise<void>(resolve => { releaseKey = resolve })
                return Response.json({ key: sodium.to_base64(keys.publicKey, sodium.base64_variants.ORIGINAL), key_id: 'test-key' })
            }
            if (options?.method === 'PUT') {
                writes.push({ url, body: JSON.parse(options.body as string) })
                return new Response(null, { status: 204 })
            }
            if (url.includes('/list.json')) return Response.json({ schema: 1, tracks: {} })
            if (url.endsWith('/user')) return Response.json({ login: SHARED_REPO.split('/')[0] })
            if (url.includes('/actions/workflows/')) return Response.json({ state: 'active', id: 1 })
            return Response.json({ full_name: SHARED_REPO, owner: { login: SHARED_REPO.split('/')[0] }, default_branch: 'main' })
        } },
    } as unknown as AddonApi
    const file = new File([cookies], 'cookies.txt', { type: 'text/plain' })
    const proxy = 'http://proxy-user:proxy-secret@203.0.113.10:8080'
    try {
        await initialize(api)
        await new Promise(resolve => setTimeout(resolve, 0))
        await assert.rejects(() => saveYoutubeCookies(file), /владельц/)
        await assert.rejects(() => saveYoutubeProxy(proxy), /владельц/)
        await saveSetup({ repo: SHARED_REPO, token: 'synthetic-owner-token', rememberToken: false })
        await saveYoutubeCookies(file)
        assert.equal(writes.length, 1)
        assert.equal(writes[0].url, `https://api.github.com/repos/${SHARED_REPO}/actions/secrets/YTDLP_COOKIES`)
        assert.equal(writes[0].body.key_id, 'test-key')
        assert.ok(!JSON.stringify(writes).includes('synthetic-youtube-session'))
        const decrypted = sodium.crypto_box_seal_open(
            sodium.from_base64(writes[0].body.encrypted_value, sodium.base64_variants.ORIGINAL), keys.publicKey, keys.privateKey,
        )
        assert.equal(sodium.to_string(decrypted), cookies)
        sodium.memzero(decrypted)
        assert.ok(!JSON.stringify([...storage]).includes('synthetic-youtube-session'))
        await saveYoutubeProxy(proxy)
        assert.equal(writes.length, 2)
        assert.equal(writes[1].url, `https://api.github.com/repos/${SHARED_REPO}/actions/secrets/YTDLP_PROXY`)
        assert.equal(writes[1].body.key_id, 'test-key')
        assert.ok(!JSON.stringify(writes).includes('proxy-secret'))
        const decryptedProxy = sodium.crypto_box_seal_open(
            sodium.from_base64(writes[1].body.encrypted_value, sodium.base64_variants.ORIGINAL), keys.publicKey, keys.privateKey,
        )
        assert.equal(sodium.to_string(decryptedProxy), proxy)
        sodium.memzero(decryptedProxy)
        await assert.rejects(() => saveYoutubeProxy('http://localhost:8080'), /Локальные/)
        assert.equal(writes.length, 2)
        permissionDenied = true
        await assert.rejects(() => saveYoutubeCookies(file), /Secrets: Read and write/)
        await assert.rejects(() => saveYoutubeProxy(proxy), /Secrets: Read and write/)
        assert.equal(writes.length, 2)
        permissionDenied = false
        delayedKey = true
        const pending = saveYoutubeCookies(file)
        while (!releaseKey) await new Promise(resolve => setTimeout(resolve, 0))
        setTestAsUser(true)
        releaseKey()
        await assert.rejects(() => pending, /режим изменился/)
        assert.equal(writes.length, 2)
        setTestAsUser(false)
        await assert.rejects(() => saveYoutubeCookies(new File(['invalid synthetic-private-value'], 'bad.txt')), /Netscape/)
        assert.equal(writes.length, 2)
    } finally {
        sodium.memzero(keys.privateKey)
        for (const callback of cleanup) callback()
    }
})
