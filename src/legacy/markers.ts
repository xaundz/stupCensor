import { getState, isMappingEnabled, subscribe } from '../store.ts'
import type { TrackMapping } from '../types.ts'

const BADGE_CLASS = 'sc-track-badge'
const STYLE_ID = 'stupidcensor-track-style'
const LINK_SELECTOR = 'a[href*="trackId="], a[href*="/track/"]'
const ROW_SELECTOR = '[data-pulsesync-track-id]'

let observer: MutationObserver | null = null
let offStore: (() => void) | null = null
let timer = 0
let style: HTMLStyleElement | null = null

function numericTrackId(raw: string | null): string | null {
    if (!raw) return null
    return /^[1-9]\d{0,19}$/.test(raw) ? raw : null
}

function trackIdFromLink(link: HTMLAnchorElement): string | null {
    try {
        const url = new URL(link.getAttribute('href') || '', location.href)
        const queryId = numericTrackId(url.searchParams.get('trackId'))
        if (queryId) return queryId
        const match = /\/track\/([1-9]\d{0,19})(?:\/|$)/.exec(url.pathname)
        return match?.[1] ?? null
    } catch {
        return null
    }
}

function mappingFor(trackId: string | null): TrackMapping | null {
    if (!trackId) return null
    const mapping = getState().library.tracks[trackId]
    return mapping && isMappingEnabled(mapping) ? mapping : null
}

function removeBadge(element: Element): void {
    const next = element.nextElementSibling
    if (next instanceof HTMLElement && next.classList.contains(BADGE_CLASS)) next.remove()
}

function badgeAfter(element: Element, mapping: TrackMapping, kind: 'link' | 'row'): void {
    let badge: HTMLElement | null =
        element.nextElementSibling instanceof HTMLElement && element.nextElementSibling.classList.contains(BADGE_CLASS)
            ? element.nextElementSibling
            : null
    if (!badge) {
        badge = document.createElement('span')
        badge.className = BADGE_CLASS
        element.insertAdjacentElement('afterend', badge)
    }
    if (badge.dataset.trackId !== mapping.trackId || badge.dataset.kind !== kind) {
        badge.dataset.trackId = mapping.trackId
        badge.dataset.kind = kind
        badge.textContent = 'SC'
        badge.title = `stupidCensor: замена активна — ${mapping.title}`
        badge.setAttribute('aria-label', 'Трек заменён stupidCensor')
    }
}

function scanLink(link: HTMLAnchorElement): void {
    const mapping = mappingFor(trackIdFromLink(link))
    if (mapping) badgeAfter(link, mapping, 'link')
    else removeBadge(link)
}

function scanRow(row: HTMLElement): void {
    const mapping = mappingFor(numericTrackId(row.getAttribute('data-pulsesync-track-id')))
    const title = row.querySelector<HTMLElement>('[data-test-id="TRACK_TITLE"]')
    if (mapping && title) badgeAfter(title, mapping, 'row')
    else if (title) removeBadge(title)
}

function scan(): void {
    for (const link of document.querySelectorAll<HTMLAnchorElement>(LINK_SELECTOR)) {
        if (link.isConnected) scanLink(link)
    }
    for (const row of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
        if (row.isConnected) scanRow(row)
    }
    for (const badge of document.querySelectorAll<HTMLElement>(`.${BADGE_CLASS}`)) {
        if (badge.dataset.kind === 'link') {
            const link = badge.previousElementSibling
            if (!(link instanceof HTMLAnchorElement) || !link.matches(LINK_SELECTOR)) badge.remove()
        } else if (badge.dataset.kind === 'row') {
            const row = badge.closest<HTMLElement>(ROW_SELECTOR)
            if (!row || !mappingFor(numericTrackId(row.getAttribute('data-pulsesync-track-id')))) badge.remove()
        }
    }
}

function schedule(): void {
    if (timer) return
    timer = window.setTimeout(() => {
        timer = 0
        scan()
    }, 180)
}

export function startReplacementMarkers(): () => void {
    if (!style) {
        style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = `
            .${BADGE_CLASS} {
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                height: 15px !important;
                padding: 0 5px !important;
                margin-left: 6px !important;
                border-radius: 999px !important;
                background: #ffdb4d !important;
                color: #17130a !important;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
                font-size: 9px !important;
                font-weight: 800 !important;
                line-height: 1 !important;
                letter-spacing: 0.04em !important;
                vertical-align: middle !important;
                cursor: default !important;
                user-select: none !important;
            }
        `
        document.head.appendChild(style)
    }

    observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    offStore = subscribe(schedule)
    schedule()

    return () => {
        observer?.disconnect()
        observer = null
        offStore?.()
        offStore = null
        if (timer) window.clearTimeout(timer)
        timer = 0
        for (const badge of document.querySelectorAll(`.${BADGE_CLASS}`)) badge.remove()
        style?.remove()
        style = null
    }
}
