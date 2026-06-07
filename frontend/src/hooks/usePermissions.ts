/**
 * usePermissions — fetches the current user's effective permissions from
 * GET /api/v1/me/permissions and exposes helpers for conditional rendering.
 *
 * Design:
 * 1. **sessionStorage layer** (survives page refresh):
 *    On first load, permissions are read synchronously from sessionStorage so
 *    the menu renders complete from the very first frame — no flash of missing items.
 * 2. **Module-level memory cache** (survives re-mounts within the same tab session):
 *    Avoids redundant API calls when Layout remounts without a userId change.
 * 3. **Background refresh**:
 *    Even when sessionStorage has data, a background fetch runs once per session
 *    to pick up any role/permission changes since the last login.
 * 4. **Graceful failure**:
 *    On API error, the hook keeps the last good cached value rather than
 *    downgrading to an empty permission set.  A retry fires after 8 s.
 * 5. **Superuser shortcut**:
 *    `user.is_superuser` (set by every login/refresh endpoint) is the synchronous
 *    fast-path so superusers never wait for the API to see the admin menu.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import api from '../api/request'
import { useAuthStore } from '../stores/auth'

export interface PermissionsResult {
  /** Flat list of permission keys, or ["*"] for superusers */
  permissions: string[]
  /** Highest tool permission level (0–3) across all roles */
  maxLevel: number
  /** True if the user is a superuser (bypasses all checks) */
  isSuperuser: boolean
  /** True while the FIRST fetch is still in progress (no cached data at all) */
  loading: boolean
  /** Returns true if the user has the given permission (or is a superuser) */
  hasPermission: (perm: string) => boolean
  /** Returns true if the user has at least one of the given permissions */
  hasAnyPermission: (perms: string[]) => boolean
}

// ── Storage helpers ────────────────────────────────────────────────────────────

type CacheEntry = { permissions: string[]; maxLevel: number; isSuperuser: boolean }

const _STORAGE_PREFIX = 'aios-perm-'

function _readStorage(userId: string): CacheEntry | null {
  try {
    const raw = sessionStorage.getItem(_STORAGE_PREFIX + userId)
    return raw ? (JSON.parse(raw) as CacheEntry) : null
  } catch {
    return null
  }
}

function _writeStorage(userId: string, entry: CacheEntry): void {
  try {
    sessionStorage.setItem(_STORAGE_PREFIX + userId, JSON.stringify(entry))
  } catch {
    // quota exceeded or private-browsing restriction — ignore
  }
}

function _clearStorage(userId: string): void {
  try {
    sessionStorage.removeItem(_STORAGE_PREFIX + userId)
  } catch {}
}

// ── Module-level memory cache (per browser tab, per page session) ─────────────
// Keyed by userId; populated after first successful API call.
const _memCache: Map<string, CacheEntry> = new Map()

// ── Hook ──────────────────────────────────────────────────────────────────────

export function usePermissions(): PermissionsResult {
  const { user } = useAuthStore()
  const userId = user?.id ?? null
  // Synchronous superuser shortcut — every login/refresh/SSO endpoint stores this
  const localIsSuperuser: boolean = user?.is_superuser ?? false

  // ── Determine best initial state synchronously ───────────────────────────
  // Priority: memory cache → sessionStorage → superuser shortcut → empty
  const _getInitialEntry = (): CacheEntry & { loading: boolean } => {
    if (!userId) return { permissions: [], maxLevel: 0, isSuperuser: false, loading: false }

    const mem = _memCache.get(userId)
    if (mem) return { ...mem, loading: false }

    const stored = _readStorage(userId)
    if (stored) {
      // Seed memory cache immediately so sibling hooks don't also hit storage
      _memCache.set(userId, stored)
      return { ...stored, loading: false }
    }

    // Nothing cached — use the superuser shortcut if available, show loading otherwise
    if (localIsSuperuser) {
      const entry: CacheEntry = { permissions: ['*'], maxLevel: 3, isSuperuser: true }
      return { ...entry, loading: false }
    }
    return { permissions: [], maxLevel: 0, isSuperuser: false, loading: true }
  }

  const [state, setState] = useState(() => _getInitialEntry())

  // fetchedRef guards against double-fetch on React StrictMode double-invoke.
  // It is per-component-instance (new mount = new ref), which is intentional:
  // a fresh mount after a genuine unmount/remount should re-run the background
  // refresh (but will still short-circuit via the cache).
  const fetchedRef = useRef(false)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const doFetch = useCallback((uid: string, background: boolean) => {
    api.get('/api/v1/me/permissions')
      .then((res: any) => {
        const entry: CacheEntry = {
          permissions: res.data.permissions ?? (localIsSuperuser ? ['*'] : []),
          maxLevel:    res.data.max_level    ?? (localIsSuperuser ? 3 : 0),
          isSuperuser: res.data.is_superuser ?? localIsSuperuser,
        }
        _memCache.set(uid, entry)
        _writeStorage(uid, entry)
        setState({ ...entry, loading: false })
      })
      .catch(() => {
        // Network / auth failure.  Never downgrade from a known-good cached value.
        const existing = _memCache.get(uid) ?? _readStorage(uid)
        if (!background || !existing) {
          // First-ever fetch failed and we have nothing — use the superuser shortcut
          const fallback: CacheEntry = {
            permissions: localIsSuperuser ? ['*'] : [],
            maxLevel:    localIsSuperuser ? 3 : 0,
            isSuperuser: localIsSuperuser,
          }
          setState({ ...fallback, loading: false })
        }
        // else: background refresh failed — keep current state, schedule retry
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
        retryTimerRef.current = setTimeout(() => {
          if (_memCache.has(uid)) {
            // Silently retry without touching the loading state
            doFetch(uid, true)
          }
        }, 8_000)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, localIsSuperuser])

  // ── Main effect: fetch / refresh permissions ──────────────────────────────
  useEffect(() => {
    if (!userId) return
    if (fetchedRef.current) return
    fetchedRef.current = true

    // If we already have cached data (from storage or memory), the UI is already
    // showing complete menu — run fetch in the background to pick up any changes.
    const hasCached = _memCache.has(userId)
    doFetch(userId, hasCached)

    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  // ── Logout / user-switch cleanup ──────────────────────────────────────────
  useEffect(() => {
    if (!userId) {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      // Clear all perm caches when user logs out
      _memCache.forEach((_, key) => _clearStorage(key))
      _memCache.clear()
      fetchedRef.current = false
      setState({ permissions: [], maxLevel: 0, isSuperuser: false, loading: false })
    }
  }, [userId])

  const hasPermission = (perm: string): boolean => {
    if (state.isSuperuser) return true
    return state.permissions.includes('*') || state.permissions.includes(perm)
  }

  const hasAnyPermission = (perms: string[]): boolean => {
    if (state.isSuperuser) return true
    if (state.permissions.includes('*')) return true
    return perms.some(p => state.permissions.includes(p))
  }

  return { ...state, hasPermission, hasAnyPermission }
}
