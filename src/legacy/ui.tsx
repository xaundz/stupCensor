import { createRoot, type Root } from 'react-dom/client'

import { Panel } from '../components/Panel.tsx'
import { getState, markJobReviewed, replaceableTrackFromJob, startAutoReplace, subscribe as subscribeStore } from '../store.ts'
import styles from '../styles.css?inline'
import type { TrackRef } from '../types.ts'
import type { LegacyContext } from './api.ts'
import { startReplacementMarkers } from './markers.ts'
import { settings } from './settings.ts'

type PanelOptions = {
    track?: TrackRef | null
    initialTab?: 'track' | 'library' | 'jobs' | 'setup'
    initialAction?: 'search' | 'manual'
}

type MenuAction = 'auto' | 'panel'

const HOST_STYLES = `
:host {
    all: initial;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
[hidden] {
    display: none !important;
}
.sc-layer {
    position: fixed;
    inset: 0;
    z-index: 2147483646;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 12px;
    background: rgba(0, 0, 0, 0.62);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
}
.sc-panel-host {
    display: contents;
}
`

function currentTrackRef(context: LegacyContext): TrackRef | null {
    const current = context.pulsesync.getCurrentTrack()
    if (!current) return null
    return {
        id: String(current.id),
        title: current.title,
        artist: (current.artists || []).map(artist => artist.name).filter(Boolean).join(', '),
        durationMs: current.durationMs || (current.duration ? current.duration * 1000 : undefined),
        albumId: current.albums?.[0]?.id === undefined ? undefined : String(current.albums[0].id),
    }
}

function trackIdFromHref(href: string | null): string | null {
    if (!href) return null
    try {
        const url = new URL(href, location.href)
        const queryId = url.searchParams.get('trackId')
        if (queryId && /^[1-9]\d{0,19}$/.test(queryId)) return queryId
        const match = /\/track\/([1-9]\d{0,19})(?:\/|$)/.exec(url.pathname)
        return match?.[1] ?? null
    } catch {
        return null
    }
}

function findTrackInAncestors(trigger: Element): TrackRef | null {
    let node: HTMLElement | null = trigger instanceof HTMLElement ? trigger : null
    for (let depth = 0; node && depth < 7 && node !== document.body; depth += 1) {
        const trackId = node.getAttribute('data-pulsesync-track-id')
        if (trackId) {
            const title = node.querySelector<HTMLElement>('[data-test-id="TRACK_TITLE"]')?.textContent?.trim()
            return { id: trackId, title: title || undefined }
        }
        const link = node.querySelector<HTMLAnchorElement>('a[href*="trackId="], a[href*="/track/"]')
        const id = trackIdFromHref(link?.getAttribute('href') ?? null)
        if (id) return { id, title: link?.textContent?.trim() || undefined }
        node = node.parentElement
    }
    return null
}

function findMenuTrack(context: LegacyContext, menu: HTMLElement): TrackRef | null {
    const parent = menu.parentElement as (HTMLElement & { ariaLabelledByElements?: Element[] }) | null
    const labelledBy = parent?.getAttribute('aria-labelledby')
    const trigger = (labelledBy ? document.getElementById(labelledBy) : null) ?? parent?.ariaLabelledByElements?.[0]
    if (!trigger) return currentTrackRef(context)
    if (
        trigger.matches(
            '[data-test-id="PLAYERBAR_DESKTOP_CONTEXT_MENU_BUTTON"], [data-test-id="FULLSCREEN_PLAYER_CONTEXT_MENU_BUTTON"]',
        )
    ) {
        return currentTrackRef(context)
    }
    return findTrackInAncestors(trigger) ?? currentTrackRef(context)
}

function setMenuItemLabel(item: HTMLElement, label: string, icon: string): void {
    const use = item.querySelector('use')
    if (use) use.setAttribute('xlink:href', `/icons/sprite.svg#${icon}`)
    const span = item.querySelector('span')
    if (span && span.childNodes[1]?.nodeType === Node.TEXT_NODE) {
        span.childNodes[1].nodeValue = label
    } else if (span) {
        span.textContent = label
    } else {
        item.textContent = label
    }
}

export function mountLegacyUi(context: LegacyContext) {
    const host = document.createElement('div')
    host.id = 'stupidcensor-host'
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })

    const style = document.createElement('style')
    style.textContent = `${HOST_STYLES}\n${styles}`
    shadow.appendChild(style)

    const layer = document.createElement('div')
    layer.className = 'sc-layer'
    layer.hidden = true
    shadow.appendChild(layer)

    let root: Root | null = null
    let panelController: AbortController | null = null
    let resolvePanel: ((value: boolean) => void) | null = null
    let activePromise: Promise<boolean> | null = null
    let previousOverflow = ''
    let lastReviewJob = ''

    const closePanel = (confirmed = false) => {
        if (!root && !resolvePanel) return
        const resolve = resolvePanel
        resolvePanel = null
        activePromise = null
        try {
            root?.unmount()
        } catch {
            // React can already be unmounted while the host is being removed.
        }
        root = null
        panelController?.abort()
        panelController = null
        layer.hidden = true
        layer.replaceChildren()
        document.documentElement.style.overflow = previousOverflow
        resolve?.(confirmed)
    }

    const openPanel = (options: PanelOptions = {}): Promise<boolean> => {
        if (activePromise) return activePromise
        const initialTrack = options.track ?? currentTrackRef(context)
        panelController = new AbortController()
        previousOverflow = document.documentElement.style.overflow
        document.documentElement.style.overflow = 'hidden'
        layer.hidden = false
        const mount = document.createElement('div')
        mount.className = 'sc-panel-host'
        layer.appendChild(mount)
        root = createRoot(mount)
        const controller = {
            signal: panelController.signal,
            close: (confirmed?: boolean) => closePanel(confirmed === true),
        }
        activePromise = new Promise<boolean>(resolve => {
            resolvePanel = resolve
        })
        root.render(
            <Panel
                controller={controller}
                initialTrack={initialTrack}
                initialTab={options.initialTab}
                initialAction={options.initialAction}
            />,
        )
        return activePromise
    }

    const showError = (message: string) => {
        void context.api.notifications.error(message).catch(() => undefined)
    }

    const runAuto = async (track: TrackRef | null) => {
        if (!track) {
            showError('Не удалось определить трек. Откройте карточку трека и попробуйте снова.')
            return
        }
        try {
            const job = await startAutoReplace(track)
            if (job?.status === 'ready') {
                await openPanel({ track: replaceableTrackFromJob(job), initialAction: 'search' })
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            showError(message)
            const needsSetup = /токен|github|репозитор|настро/i.test(message)
            void openPanel({ track, initialTab: needsSetup ? 'setup' : 'track' })
        }
    }

    const onLayerPointerDown = (event: PointerEvent) => {
        if (event.target === layer) closePanel()
    }
    layer.addEventListener('pointerdown', onLayerPointerDown)

    const offSettings = settings.subscribe(() => {
        if (!settings.store.enabled) closePanel()
        ensurePlayerButton()
    })

    const offJobs = subscribeStore(() => {
        if (!settings.store.enabled || activePromise) return
        const job = getState().jobs.find(item => item.auto && item.needsReview)
        if (!job || job.id === lastReviewJob) return
        lastReviewJob = job.id
        markJobReviewed(job.id)
        void openPanel({ track: replaceableTrackFromJob(job), initialAction: 'search' })
    })

    const markers = startReplacementMarkers()

    const ensurePlayerButton = () => {
        const existing = document.querySelector<HTMLElement>('[data-test-id="STUPIDCENSOR_PLAYER_BUTTON"]')
        if (!settings.store.enabled) {
            existing?.remove()
            return
        }
        const sample = document.querySelector<HTMLElement>(
            '[data-test-id="PLAYERBAR_DESKTOP_CONTEXT_MENU_BUTTON"]',
        )
        const parent = sample?.parentElement
        if (!sample || !parent) return
        if (existing && parent.contains(existing)) return
        existing?.remove()
        const button = sample.cloneNode(true) as HTMLElement
        button.removeAttribute('id')
        button.removeAttribute('aria-expanded')
        button.removeAttribute('aria-haspopup')
        button.removeAttribute('aria-live')
        button.removeAttribute('aria-busy')
        button.setAttribute('data-test-id', 'STUPIDCENSOR_PLAYER_BUTTON')
        button.setAttribute('aria-label', 'stupidCensor')
        button.setAttribute('title', 'stupidCensor')
        const use = button.querySelector('use')
        if (use) {
            use.setAttribute('href', '/icons/sprite.svg#link_xxs')
            use.setAttribute('xlink:href', '/icons/sprite.svg#link_xxs')
        }
        button.addEventListener('click', event => {
            event.preventDefault()
            event.stopPropagation()
            void openPanel({ track: currentTrackRef(context), initialTab: 'track' })
        })
        parent.insertBefore(button, sample)
    }

    const addMenuItems = (menu: HTMLElement) => {
        if (!settings.store.enabled) return
        if (menu.querySelector('[data-test-id="STUPIDCENSOR_MENU_AUTO"]')) return
        const sample =
            menu.querySelector<HTMLElement>('[data-test-id="CONTEXT_MENU_DOWNLOAD_BUTTON"]') ??
            menu.querySelector<HTMLElement>('[role="menuitem"], button')
        const parent = sample?.parentElement
        if (!sample || !parent) return
        const track = findMenuTrack(context, menu)
        const createItem = (id: string, label: string, icon: string, action: MenuAction) => {
            const item = sample.cloneNode(true) as HTMLElement
            item.removeAttribute('id')
            item.removeAttribute('aria-checked')
            for (const element of item.querySelectorAll('[id]')) element.removeAttribute('id')
            item.setAttribute('data-test-id', id)
            setMenuItemLabel(item, label, icon)
            item.addEventListener('click', event => {
                event.preventDefault()
                event.stopPropagation()
                menu.remove()
                if (action === 'auto') void runAuto(track)
                else void openPanel({ track, initialTab: 'track' })
            })
            return item
        }
        const auto = createItem(
            'STUPIDCENSOR_MENU_AUTO',
            'Найти без цензуры',
            'edit_xxs',
            'auto',
        )
        const panel = createItem(
            'STUPIDCENSOR_MENU_PANEL',
            'stupidCensor: открыть',
            'link_xxs',
            'panel',
        )
        parent.insertBefore(auto, sample.nextSibling)
        parent.insertBefore(panel, auto.nextSibling)
    }

    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement)) continue
                if (node.matches('[data-test-id="TRACK_CONTEXT_MENU"]')) {
                    addMenuItems(node)
                    continue
                }
                for (const menu of node.querySelectorAll<HTMLElement>('[data-test-id="TRACK_CONTEXT_MENU"]')) {
                    addMenuItems(menu)
                }
            }
        }
        ensurePlayerButton()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    ensurePlayerButton()

    return {
        openPanel,
        close: () => closePanel(),
        cleanup: () => {
            closePanel()
            observer.disconnect()
            document.querySelector('[data-test-id="STUPIDCENSOR_PLAYER_BUTTON"]')?.remove()
            offSettings()
            offJobs()
            markers()
            layer.removeEventListener('pointerdown', onLayerPointerDown)
            host.remove()
        },
    }
}
