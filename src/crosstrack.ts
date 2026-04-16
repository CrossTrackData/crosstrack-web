/**
 * CrossTrack Web SDK
 *
 * Drop-in script for websites that:
 * - Generates and persists a visitor ID (localStorage + cookie)
 * - Tracks page views and custom events
 * - Reads the WebView bridge device ID (injected by the Android/iOS SDK)
 * - Sends events to the CrossTrack backend with identity context
 * - Respects consent before tracking
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrossTrackConfig {
  apiKey: string
  collectionUrl: string
  flushIntervalMs?: number
  maxQueueSize?: number
  maxBatchSizeBytes?: number
  autoPageView?: boolean
}

export type ConsentState = "opted_in" | "opted_out" | "not_set"

interface EventPayload {
  eventId: string
  anonymousId: string
  userId?: string
  type: string
  properties: Record<string, unknown>
  context: EventContext
  timestamp: string
}

interface EventContext {
  bridgeId?: string
  sdkVersion: string
  platform: "web"
  sessionId: string
  page: {
    url: string
    path: string
    title: string
    referrer: string
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SDK_VERSION = "0.1.0"
const STORAGE_PREFIX = "crosstrack_"
const VISITOR_ID_KEY = `${STORAGE_PREFIX}visitor_id`
const CONSENT_KEY = `${STORAGE_PREFIX}consent`
const SESSION_ID_KEY = `${STORAGE_PREFIX}session_id`
const SESSION_LAST_ACTIVITY_KEY = `${STORAGE_PREFIX}session_last_activity`
const BRIDGE_DEVICE_ID_KEY = `${STORAGE_PREFIX}device_id` // Written by Android/iOS SDK WebView bridge
const SESSION_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

const DEFAULT_CONFIG: Required<Omit<CrossTrackConfig, "apiKey" | "collectionUrl">> = {
  flushIntervalMs: 30_000,
  maxQueueSize: 500,
  maxBatchSizeBytes: 102_400,
  autoPageView: true,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let config: CrossTrackConfig & typeof DEFAULT_CONFIG
let initialized = false
let flushTimer: ReturnType<typeof setInterval> | null = null
let userId: string | undefined
const eventQueue: EventPayload[] = []

// ---------------------------------------------------------------------------
// UUID
// ---------------------------------------------------------------------------

function uuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  // Fallback for older browsers
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage may be unavailable (incognito, storage full)
  }
}

function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Visitor ID
// ---------------------------------------------------------------------------

function getOrCreateVisitorId(): string {
  let id = storageGet(VISITOR_ID_KEY)
  if (!id) {
    id = uuid()
    storageSet(VISITOR_ID_KEY, id)
  }
  return id
}

function resetVisitorId(): void {
  storageRemove(VISITOR_ID_KEY)
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

function getOrCreateSession(): string {
  const lastActivity = storageGet(SESSION_LAST_ACTIVITY_KEY)
  const existingSession = storageGet(SESSION_ID_KEY)
  const now = Date.now()

  if (existingSession && lastActivity) {
    const elapsed = now - parseInt(lastActivity, 10)
    if (elapsed < SESSION_TIMEOUT_MS) {
      storageSet(SESSION_LAST_ACTIVITY_KEY, now.toString())
      return existingSession
    }
  }

  // New session
  const newSession = uuid()
  storageSet(SESSION_ID_KEY, newSession)
  storageSet(SESSION_LAST_ACTIVITY_KEY, now.toString())
  return newSession
}

// ---------------------------------------------------------------------------
// WebView Bridge - reads device ID injected by Android/iOS SDK
// ---------------------------------------------------------------------------

function getBridgeDeviceId(): string | undefined {
  const bridgeId = storageGet(BRIDGE_DEVICE_ID_KEY)
  return bridgeId || undefined
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

function getConsent(): ConsentState {
  return (storageGet(CONSENT_KEY) as ConsentState) || "not_set"
}

function isTrackingAllowed(): boolean {
  return getConsent() === "opted_in"
}

// ---------------------------------------------------------------------------
// Event building
// ---------------------------------------------------------------------------

function buildEvent(type: string, properties: Record<string, unknown> = {}): EventPayload {
  return {
    eventId: uuid(),
    anonymousId: getOrCreateVisitorId(),
    userId: userId,
    type: type,
    properties: properties,
    context: {
      bridgeId: getBridgeDeviceId(),
      sdkVersion: SDK_VERSION,
      platform: "web",
      sessionId: getOrCreateSession(),
      page: {
        url: window.location.href,
        path: window.location.pathname,
        title: document.title,
        referrer: document.referrer,
      },
    },
    timestamp: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Queue & Flush
// ---------------------------------------------------------------------------

function enqueue(event: EventPayload): void {
  if (eventQueue.length >= config.maxQueueSize) {
    eventQueue.shift() // Drop oldest
  }
  eventQueue.push(event)
}

async function flushQueue(): Promise<void> {
  if (eventQueue.length === 0) return
  if (!isTrackingAllowed()) return

  // Take all events from the queue
  const batch = eventQueue.splice(0, eventQueue.length)

  try {
    const response = await fetch(`${config.collectionUrl}/v1/events/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
      },
      body: JSON.stringify({ events: batch }),
      keepalive: true, // Allow sending during page unload
    })

    if (!response.ok) {
      // Re-queue on failure
      eventQueue.unshift(...batch)
    }
  } catch {
    // Network error — re-queue
    eventQueue.unshift(...batch)
  }
}

function startFlushLoop(): void {
  if (flushTimer) return
  flushTimer = setInterval(() => {
    flushQueue()
  }, config.flushIntervalMs)
}

function stopFlushLoop(): void {
  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the SDK. Must be called before any tracking methods.
 */
export function init(userConfig: CrossTrackConfig): void {
  if (initialized) return

  config = { ...DEFAULT_CONFIG, ...userConfig }
  initialized = true

  startFlushLoop()

  // Auto page view
  if (config.autoPageView && isTrackingAllowed()) {
    track("page_view")
  }

  // Flush on page unload
  if (typeof window !== "undefined") {
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushQueue()
      }
    })
  }
}

/**
 * Set consent state. Must be "opted_in" before any events are tracked.
 */
export function consent(state: ConsentState): void {
  storageSet(CONSENT_KEY, state)

  if (state === "opted_out") {
    // Clear queue and reset visitor ID
    eventQueue.length = 0
    resetVisitorId()
    stopFlushLoop()
  } else if (state === "opted_in" && initialized) {
    startFlushLoop()
  }
}

/**
 * Get current consent state.
 */
export function getConsentState(): ConsentState {
  return getConsent()
}

/**
 * Track a custom event.
 */
export function track(eventType: string, properties: Record<string, unknown> = {}): void {
  if (!initialized || !isTrackingAllowed()) return
  enqueue(buildEvent(eventType, properties))
}

/**
 * Track a page view. Called automatically if autoPageView is true.
 */
export function page(properties: Record<string, unknown> = {}): void {
  track("page_view", properties)
}

/**
 * Identify the current visitor with a known user ID.
 * This links the anonymous visitor ID to the known user.
 */
export function identify(
  id: string,
  traits: Record<string, string> = {}
): void {
  if (!initialized) return
  userId = id

  if (!isTrackingAllowed()) return

  // Send identify call directly to the backend
  const payload = {
    anonymousId: getOrCreateVisitorId(),
    userId: id,
    traits: traits,
  }

  fetch(`${config.collectionUrl}/v1/identify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.apiKey,
    },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Silently fail — don't crash the customer's site
  })
}

/**
 * Flush all queued events immediately.
 */
export function flush(): void {
  flushQueue()
}

/**
 * Reset the visitor ID and clear all local state. Call on logout.
 */
export function reset(): void {
  userId = undefined
  eventQueue.length = 0
  resetVisitorId()
  storageRemove(SESSION_ID_KEY)
  storageRemove(SESSION_LAST_ACTIVITY_KEY)
}

/**
 * Shut down the SDK.
 */
export function shutdown(): void {
  flushQueue()
  stopFlushLoop()
  initialized = false
}

/**
 * Get the current visitor ID (for debugging or cross-domain linking).
 */
export function getVisitorId(): string | null {
  return storageGet(VISITOR_ID_KEY)
}

/**
 * Get the bridge device ID if present (set by Android/iOS SDK via WebView).
 */
export function getBridgeId(): string | undefined {
  return getBridgeDeviceId()
}

/**
 * Decorate a URL with CrossTrack identity params for cross-domain linking.
 */
export function decorateUrl(url: string): string {
  const visitorId = getOrCreateVisitorId()
  const sessionId = getOrCreateSession()
  const separator = url.includes("?") ? "&" : "?"
  return `${url}${separator}ct_vid=${encodeURIComponent(visitorId)}&ct_sid=${encodeURIComponent(sessionId)}`
}
