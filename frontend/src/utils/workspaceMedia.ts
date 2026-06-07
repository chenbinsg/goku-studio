/**
 * Utilities for normalising backend media/API URLs so chat-rendered Markdown
 * stays valid even when the backend host/port changes between environments.
 *
 * Two concerns are handled here:
 *  1. Converting /api/... paths into fully-qualified URLs on the current origin.
 *  2. Rewriting Markdown content that embeds backend URLs so stale hosts/ports
 *     do not leak into rendered links or images.
 */

function buildCurrentOriginApiUrl(apiPath: string): string {
  return `${window.location.origin}${apiPath}`
}

/**
 * Normalize any backend API URL to the current page origin.
 *
 * Supported inputs:
 *   - /api/v1/workspace/images/foo.png
 *   - http://127.0.0.1:5106/api/v1/workspace/images/foo.png
 *   - https://example.com/api/v1/tasks/123
 *
 * Non-API URLs are returned unchanged.
 */
export function normalizeApiUrl(src: string | undefined | null): string | null {
  if (!src) return null

  if (src.startsWith('/api/')) {
    return buildCurrentOriginApiUrl(src)
  }

  if (/^https?:\/\//i.test(src)) {
    try {
      const parsed = new URL(src)
      if (parsed.pathname.startsWith('/api/')) {
        return buildCurrentOriginApiUrl(`${parsed.pathname}${parsed.search}${parsed.hash}`)
      }
    } catch {
      return src
    }
    return src
  }

  return src
}

/**
 * Given an <img src> value that may be:
 *   - a relative workspace path  (/api/v1/workspace/images/…)
 *   - an absolute workspace URL  (http://…/api/v1/workspace/images/…)
 *   - any other URL
 *   - undefined / null
 *
 * Returns the src to use for the <img> element, or null when src is falsy.
 * Relative workspace paths are prefixed with window.location.origin so they
 * resolve correctly when the frontend is served from a sub-path.
 */
export function normalizeWorkspaceImageUrl(src: string | undefined | null): string | null {
  const normalized = normalizeApiUrl(src)
  if (!normalized) return null

  // Any other relative or data: URL – return as-is (ReactMarkdown passes
  // them through; returning null would suppress all non-workspace images)
  return normalized
}

/**
 * Rewrites every workspace image path that appears inside Markdown image
 * syntax  ![alt](…)  so the URL is absolute before ReactMarkdown processes
 * it. Without this, relative paths resolve against the page's base URL and
 * break when the image component calls normalizeWorkspaceImageUrl.
 *
 * Example:
 *   "![chart](/api/v1/workspace/images/chart.png)"
 *   → "![chart](http://localhost:8106/api/v1/workspace/images/chart.png)"
 */
export function rewriteWorkspaceImageUrlsInMarkdown(content: string): string {
  if (!content) return content

  // Match Markdown image syntax where the URL is a relative workspace path
  return content.replace(
    /!\[([^\]]*)\]\((\/api\/v1\/workspace\/images\/[^)]+)\)/g,
    (_match, alt, path) => `![${alt}](${buildCurrentOriginApiUrl(path)})`
  )
}

/**
 * Rewrite Markdown links/images that point at any backend /api/... URL so they
 * always resolve against the current frontend origin.
 */
export function rewriteApiUrlsInMarkdown(content: string): string {
  if (!content) return content

  return content.replace(
    /\]\(((?:https?:\/\/[^)\s]+)?\/api\/[^)\s]*)\)/g,
    (_match, rawUrl) => `](${normalizeApiUrl(rawUrl) ?? rawUrl})`
  )
}
