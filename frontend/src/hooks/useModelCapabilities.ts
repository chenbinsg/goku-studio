/**
 * useModelCapabilities
 * --------------------
 * Fetches model capability flags from the backend registry and caches them
 * in-memory for the lifetime of the page. Avoids repeated network calls when
 * the same model string is queried multiple times.
 *
 * Usage:
 *   const caps = useModelCapabilities('claude-sonnet-4-6')
 *   if (caps.supports_thinking) { ... }
 */
import { useState, useEffect, useRef } from 'react'
import api from '../api/request'

export interface ModelCapabilities {
  model: string
  supports_tools: boolean
  supports_vision: boolean
  supports_thinking: boolean
  supports_streaming: boolean
  supports_temperature: boolean
  uses_max_completion_tokens: boolean
  context_window: number
  max_output_tokens: number
  default_thinking_budget: number
}

// Module-level cache — persists across re-renders and component unmounts
const _cache: Record<string, ModelCapabilities> = {}

// Sensible defaults while loading (conservative — hides advanced features until known)
const DEFAULT_CAPS: ModelCapabilities = {
  model: '',
  supports_tools: true,
  supports_vision: false,
  supports_thinking: false,
  supports_streaming: true,
  supports_temperature: true,
  uses_max_completion_tokens: false,
  context_window: 128_000,
  max_output_tokens: 0,
  default_thinking_budget: 5_000,
}

export function useModelCapabilities(model: string): ModelCapabilities {
  const [caps, setCaps] = useState<ModelCapabilities>(() => {
    // Return cache hit immediately if available, otherwise defaults
    return model ? (_cache[model] ?? { ...DEFAULT_CAPS, model }) : DEFAULT_CAPS
  })

  // Track current model to avoid stale state updates
  const modelRef = useRef(model)
  modelRef.current = model

  useEffect(() => {
    if (!model) {
      setCaps(DEFAULT_CAPS)
      return
    }

    // Already cached — set synchronously and skip fetch
    if (_cache[model]) {
      setCaps(_cache[model])
      return
    }

    let cancelled = false
    const encoded = encodeURIComponent(model)

    api
      .get<ModelCapabilities>(`/api/v1/models/capabilities/${encoded}`)
      .then((res) => {
        if (cancelled) return
        const data = res.data
        _cache[model] = data
        if (modelRef.current === model) {
          setCaps(data)
        }
      })
      .catch(() => {
        // On error fall back to defaults — don't crash UI
        if (cancelled) return
        const fallback = { ...DEFAULT_CAPS, model }
        _cache[model] = fallback
        if (modelRef.current === model) {
          setCaps(fallback)
        }
      })

    return () => {
      cancelled = true
    }
  }, [model])

  return caps
}
