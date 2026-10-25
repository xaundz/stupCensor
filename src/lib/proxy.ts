export const PROXY_URL_LIMIT = 512

export class ProxyUrlError extends Error {}

function privateHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
        return true
    }
    if (host === '::' || host === '::1' || /^(?:fc|fd|fe8|fe9|fea|feb)/.test(host)) return true
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false
    const parts = host.split('.').map(Number)
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
        (parts[0] === 169 && parts[1] === 254) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
        (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19))
}

export function normalizeProxyUrl(value: string): string {
    const text = value.trim()
    if (!text) throw new ProxyUrlError('Укажите адрес прокси.')
    if (text.length > PROXY_URL_LIMIT) throw new ProxyUrlError('Адрес прокси слишком длинный.')
    if (/[\s\x00-\x1f\x7f]/.test(text)) throw new ProxyUrlError('Адрес прокси содержит недопустимые символы.')
    let url: URL
    try {
        url = new URL(text)
    } catch {
        throw new ProxyUrlError('Нужен адрес вида http://host:port или socks5://host:port.')
    }
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) {
        throw new ProxyUrlError('Поддерживаются только http, https, socks5 и socks5h.')
    }
    const authority = text.slice(text.indexOf('://') + 3).split(/[/?#]/, 1)[0]
    const hostPort = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
    const explicitPort = /^(?:\[[^\]]+\]|[^:]+):(\d+)$/.exec(hostPort)
    if (!url.hostname || !explicitPort || Number(explicitPort[1]) === 0 || Number(explicitPort[1]) > 65535) {
        throw new ProxyUrlError('В адресе прокси нужен хост и порт, например http://host:8080.')
    }
    if ((url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
        throw new ProxyUrlError('Укажите только адрес прокси без пути, параметров и якоря.')
    }
    if (privateHost(url.hostname)) {
        throw new ProxyUrlError('Локальные и служебные адреса не подходят: GitHub Actions не сможет к ним подключиться.')
    }
    return url.href.replace(/\/$/, '')
}
