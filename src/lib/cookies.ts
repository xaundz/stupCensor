export const COOKIE_FILE_LIMIT = 48 * 1024

export class CookieFileError extends Error {}

export function normalizeYoutubeCookies(text: string, now = Date.now()): string {
    if (new TextEncoder().encode(text).length > COOKIE_FILE_LIMIT) {
        throw new CookieFileError('Файл больше 48 КБ. Экспортируйте cookies только для youtube.com.')
    }
    text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    if (!/^# (?:Netscape HTTP Cookie File|HTTP Cookie File)(?:\n|$)/.test(text) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
        throw new CookieFileError('Нужен файл cookies.txt в формате Netscape, не JSON и не пароль Google.')
    }
    const rows: string[] = []
    for (const line of text.split('\n')) {
        if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue
        const parts = line.split('\t')
        if (parts.length !== 7 || !['TRUE', 'FALSE'].includes(parts[1]) || !parts[2].startsWith('/') ||
            !['TRUE', 'FALSE'].includes(parts[3]) || !/^\d+$/.test(parts[4]) || !parts[5]) {
            throw new CookieFileError('Файл повреждён или имеет неверный формат. Экспортируйте cookies заново в Netscape.')
        }
        const host = parts[0].replace(/^#HttpOnly_/, '').replace(/^\./, '').toLowerCase()
        if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) continue
        const expiry = Number(parts[4])
        if (!Number.isSafeInteger(expiry) || (expiry > 0 && expiry * 1000 <= now)) continue
        rows.push(line)
    }
    if (!rows.length) {
        throw new CookieFileError('В файле нет действующих cookies YouTube. Войдите на youtube.com и экспортируйте их заново.')
    }
    const result = '# Netscape HTTP Cookie File\n' + rows.join('\n') + '\n'
    if (new TextEncoder().encode(result).length > COOKIE_FILE_LIMIT) throw new CookieFileError('Cookies превышают лимит GitHub 48 КБ.')
    return result
}

export async function encryptCookies(contents: string, publicKey: string): Promise<string> {
    try {
        const { default: sodium } = await import('libsodium-wrappers')
        await sodium.ready
        const key = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL)
        if (key.length !== sodium.crypto_box_PUBLICKEYBYTES) throw new Error('Invalid key')
        const bytes = sodium.from_string(contents)
        try {
            return sodium.to_base64(sodium.crypto_box_seal(bytes, key), sodium.base64_variants.ORIGINAL)
        } finally {
            sodium.memzero(bytes)
        }
    } catch {
        throw new CookieFileError('Не удалось зашифровать cookies ключом GitHub. Попробуйте ещё раз.')
    }
}
