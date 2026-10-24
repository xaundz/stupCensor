import assert from 'node:assert/strict'
import test from 'node:test'
import { getSourcePreview } from '../src/lib/preview.ts'

const videoId = 'aB0_-cD1234'

test('YouTube supports only watch, short links, shorts and embed with exact video IDs', () => {
    for (const page of [
        `https://youtube.com/watch?v=${videoId}&autoplay=1`,
        `https://www.youtube.com/watch?v=${videoId}&list=ignored`,
        `https://m.youtube.com/shorts/${videoId}`,
        `https://youtu.be/${videoId}?t=30`,
        `https://www.youtube.com/embed/${videoId}#ignored`,
    ]) {
        assert.deepEqual(getSourcePreview('youtube', page), {
            provider: 'youtube',
            embedUrl: `https://www.youtube.com/embed/${videoId}?autoplay=0`,
            sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
        })
    }
})

test('YouTube rejects invalid IDs and unsupported paths', () => {
    for (const path of [
        '/watch', '/watch?v=short', `/watch?v=${videoId}x`,
        '/watch?v=abcdefghij!', '/watch?v=abcdefghij%2F',
        `/watch?v=${videoId}%0A`, `/watch?v=${videoId}%0D`,
        `/live/${videoId}`, `/shorts/${videoId}/extra`, `/embed/${videoId}/`,
        `/playlist?list=${videoId}`, `/watch/extra?v=${videoId}`,
    ]) assert.equal(getSourcePreview('youtube', `https://youtube.com${path}`), null, path)
    assert.equal(getSourcePreview('youtube', `https://youtu.be/${videoId}/extra`), null)
})

test('SoundCloud uses the official compact widget with an encoded canonical HTTPS page', () => {
    for (const host of ['soundcloud.com', 'www.soundcloud.com']) {
        const preview = getSourcePreview('soundcloud', `https://${host}/artist-name/track_123/?utm_source=test&auto_play=true#fragment`)
        assert.ok(preview)
        assert.equal(preview.sourceUrl, 'https://soundcloud.com/artist-name/track_123')
        assert.ok(preview.embedUrl.includes('url=https%3A%2F%2Fsoundcloud.com%2Fartist-name%2Ftrack_123'))
        const widget = new URL(preview.embedUrl)
        assert.equal(widget.origin, 'https://w.soundcloud.com')
        assert.equal(widget.pathname, '/player/')
        assert.equal(widget.searchParams.get('auto_play'), 'false')
        assert.equal(widget.searchParams.get('visual'), 'false')
        assert.equal(widget.searchParams.get('url'), preview.sourceUrl)
        assert.ok(!preview.embedUrl.includes('utm_source'))
    }
})

test('SoundCloud rejects non-public track shapes, private tokens and widget URLs', () => {
    for (const path of [
        '/', '/artist', '/artist/sets/album', '/artist/track/s-private',
        '/discover/sets', '/you/likes', '/artist/track?secret_token=s-private',
        '/artist/track?TOKEN=private', '/artist/track?password=private',
        '/artist%2Fother/track',
    ]) assert.equal(getSourcePreview('soundcloud', `https://soundcloud.com${path}`), null, path)
    assert.equal(getSourcePreview('soundcloud', 'https://w.soundcloud.com/player/?url=https://example.com'), null)
})

test('strict whitelist rejects spoofed hosts, credentials, ports, schemes and provider mismatches', () => {
    for (const [provider, host, path] of [
        ['youtube', 'youtube.com', `/watch?v=${videoId}`],
        ['soundcloud', 'soundcloud.com', '/artist/track'],
    ]) {
        for (const page of [
            `https://${host}.evil.test${path}`, `https://evil${host}${path}`,
            `https://evil.test/${host}${path}`, `https://${host}@evil.test${path}`,
            `https://user:pass@${host}${path}`, `https://user@${host}${path}`,
            `https://${host}:8443${path}`, `https://${host}.${path}`,
            `http://${host}${path}`, `//${host}${path}`,
            'javascript:alert(1)', 'data:text/html,test', 'not a URL', '',
        ]) assert.equal(getSourcePreview(provider, page), null, page)
    }
    assert.equal(getSourcePreview('youtube', 'https://soundcloud.com/artist/track'), null)
    assert.equal(getSourcePreview('soundcloud', `https://youtube.com/watch?v=${videoId}`), null)
    for (const provider of ['rutube', 'dailymotion', 'vimeo', 'bandcamp', 'vk', 'manual', 'unknown']) {
        assert.equal(getSourcePreview(provider, `https://youtube.com/watch?v=${videoId}`), null)
    }
})
