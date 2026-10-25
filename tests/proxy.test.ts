import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeProxyUrl, ProxyUrlError } from '../src/lib/proxy.ts'

test('proxy accepts supported schemes and preserves credentials', () => {
    assert.equal(
        normalizeProxyUrl('http://user:pass@203.0.113.10:8080'),
        'http://user:pass@203.0.113.10:8080',
    )
    assert.equal(normalizeProxyUrl('socks5h://proxy.example:1080'), 'socks5h://proxy.example:1080')
    assert.equal(normalizeProxyUrl('https://proxy.example:443'), 'https://proxy.example')
})

test('proxy rejects local, malformed and unsupported values without echoing credentials', () => {
    const values = [
        '',
        'http://localhost:8080',
        'http://127.0.0.1:8080',
        'http://10.0.0.1:8080',
        'http://172.16.0.1:8080',
        'http://192.168.1.1:8080',
        'http://169.254.169.254:80',
        'http://[::1]:8080',
        'ftp://proxy.example:21',
        'http://proxy.example',
        'http://proxy.example:0',
        'http://proxy.example:8080/path',
        'http://proxy.example:8080?x=1',
        'http://proxy.example:8080#x',
        'http://proxy.example:8080 bad',
        'x'.repeat(513),
        'socks5://user:secret@localhost:1080',
    ]
    for (const value of values) {
        assert.throws(() => normalizeProxyUrl(value), error => {
            assert.ok(error instanceof ProxyUrlError)
            assert.ok(!error.message.includes('secret'))
            return true
        })
    }
})
