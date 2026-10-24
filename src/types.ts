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

export type MediaProvider =
    | 'youtube'
    | 'soundcloud'
    | 'rutube'
    | 'dailymotion'
    | 'vimeo'
    | 'bandcamp'
    | 'vk'
    | 'unknown'

export type SourceCandidate = {
    id: string
    provider: MediaProvider
    pageUrl: string
    title: string
    artist: string
    uploader: string
    durationMs: number
    score: number
    warnings: string[]
    unavailable?: boolean
    unavailableReason?: string
}

export type SourceInfo = {
    provider: MediaProvider | 'manual'
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

export type JobStatus =
    | 'queued'
    | 'running'
    | 'ready'
    | 'awaiting_approval'
    | 'published'
    | 'failed'
    | 'updated'
    | 'removed'
    | 'abandoned'
    | 'rejected'

export type JobError = {
    code: string
    message: string
    detail?: string
}

export type JobRecord = {
    id: string
    action: 'search' | 'confirm' | 'manual' | 'toggle' | 'remove' | 'check'
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
    // Undefined is a legacy status; empty means the worker found no mapping to remove.
    removedAudioUrl?: string
    error?: JobError
    runUrl?: string
    runId?: number
    issueUrl?: string
    requestUrl?: string
    requestSourceUrl?: string
    externalRequest?: boolean
    issueNumber?: number
    requestedBy?: string
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
    note?: string
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
    canAdmin?: boolean
    owner?: string
    viewer?: string
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
    workflow: WorkflowInfo | null
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
