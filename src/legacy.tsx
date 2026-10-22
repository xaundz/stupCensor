import { createLegacyApi } from './legacy/api.ts'
import { mountLegacyUi } from './legacy/ui.tsx'
import { initialize, setLastError } from './store.ts'

const previous = window.__stupidCensorCleanup
if (previous) {
    try {
        previous()
    } catch {
        // Ignore a stale instance that is already gone.
    }
}

let context: ReturnType<typeof createLegacyApi>
try {
    context = createLegacyApi()
} catch (error) {
    console.error('[stupidCensor] PulseSync API is not available', error)
    throw error
}

const ui = mountLegacyUi(context)
const cleanup = () => {
    ui.cleanup()
    context.dispose()
}
window.__stupidCensorCleanup = cleanup

void initialize(context.api).catch(error => {
    context.api.logger.error('stupidCensor: ошибка инициализации', error)
    setLastError(error instanceof Error ? error.message : String(error))
    void context.api.notifications.error('stupidCensor не смог инициализироваться.').catch(() => undefined)
})
