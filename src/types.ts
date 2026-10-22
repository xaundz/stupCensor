export type TrackRef = {
    id: string
    title?: string
    artist?: string
    durationMs?: number
    albumId?: string
}

export type TrackSearchMeta = {
    id: string
    title: string
    artist: string
    durationMs: number
}

export type SourceCandidate = {
    id: string
    provider: 'youtube' | 'soundcloud'
    pageUrl: string
    title: string
    artist: string
    uploader: string
    durationMs: number
    score: number
    warnings: string[]
}

export type SourceInfo = {
    provider: 'youtube' | 'soundcloud' | 'manual' | 'unknown'
    pageUrl: string
    title: string
    artist: string
    uploader?: string
    durationMs?: number
    score?: number
    warnings?: string[]
    manual?: boolean
}

export type TrackMapping = {
    trackId: string
    title: string
    artists: string[]
    durationMs: number
    enabled: boolean
    audioUrl: string
    assetName: string
    releaseTag: string
    source: SourceInfo
    addedAt: string
    updatedAt: string
}

export type LibraryIndex = {
    schema: number
    name?: string
    updatedAt?: string
    tracks: Record<string, TrackMapping>
}

export type JobStatus = 'queued' | 'running' | 'ready' | 'published' | 'failed' | 'updated' | 'removed' | 'abandoned'

export type JobError = {
    code: string
    message: string
    detail?: string
}

export type JobRecord = {
    id: string
    action: 'search' | 'confirm' | 'manual' | 'toggle' | 'remove'
    status: JobStatus
    repo: string
    branch: string
    trackId: string
    trackTitle: string
    trackArtist: string
    createdAt: string
    updatedAt: string
    expiresAt?: string
    sourceJobId?: string
    candidateId?: string
    candidates?: SourceCandidate[]
    published?: {
        audioUrl: string
        assetName: string
    }
    error?: JobError
    runUrl?: string
    runId?: number
    startedAt?: string
    finishedAt?: string
    etaSeconds?: number
    cancelRequested?: boolean
    processed?: boolean
    silent?: boolean
    manualUrl?: string
    auto?: boolean
    needsReview?: boolean
    trackDurationMs?: number
    autoConfirmed?: boolean
}

export type GitHubConfig = {
    repo: string
    branch: string
    rememberToken: boolean
    publicVerified: boolean
}

export type RepoInfo = {
    fullName: string
    private: boolean
    defaultBranch: string
    htmlUrl: string
    canPush?: boolean
}

export type WorkflowInfo = {
    id: number
    name: string
    path: string
    state: string
    htmlUrl: string
}

export type WorkflowRun = {
    id: number
    status: string
    conclusion: string | null
    htmlUrl: string
    displayTitle: string
    startedAt?: string
}

export type SetupResult = {
    repo: RepoInfo
    workflow: WorkflowInfo
}

export type SetupForm = {
    repo: string
    token: string
    rememberToken: boolean
}

export type SearchForm = {
    title: string
    artist: string
    durationSec: number
    sourceUrl: string
}

export type ToastKind = 'info' | 'error' | 'success'

export type AppNotice = {
    kind: ToastKind
    text: string
    at: number
}
