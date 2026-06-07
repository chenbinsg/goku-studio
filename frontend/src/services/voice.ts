/**
 * Voice I/O service using Web Speech API (STT) and SpeechSynthesis (TTS).
 */

// Extend Window type for webkit prefix
declare global {
  interface Window {
    webkitSpeechRecognition: any
    SpeechRecognition: any
  }
}

export interface VoiceListenOptions {
  lang?: string
  onResult: (text: string, isFinal: boolean) => void
  onEnd: () => void
  onError: (error: string) => void
}

class VoiceService {
  private recognition: any = null
  private synthesis = typeof window !== 'undefined' ? window.speechSynthesis : null

  isSupported(): boolean {
    if (typeof window === 'undefined') return false
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition)
  }

  isTTSSupported(): boolean {
    return !!this.synthesis
  }

  detectLanguage(text: string): string {
    const source = (text || '').trim()
    if (!source) return 'zh-CN'

    const japaneseChars = (source.match(/[\u3040-\u30ff]/g) || []).length
    const chineseChars = (source.match(/[\u4e00-\u9fff]/g) || []).length
    const latinChars = (source.match(/[A-Za-z]/g) || []).length

    if (japaneseChars > 0) return 'ja-JP'
    if (chineseChars > 0 && latinChars < chineseChars) return 'zh-CN'
    if (latinChars > 0) return 'en-US'
    return 'zh-CN'
  }

  startListening(options: VoiceListenOptions) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      options.onError('SpeechRecognition not supported')
      return
    }

    this.recognition = new SpeechRecognition()
    this.recognition.lang = options.lang || 'zh-CN'
    this.recognition.continuous = true
    this.recognition.interimResults = true

    this.recognition.onresult = (event: any) => {
      const result = event.results[event.results.length - 1]
      if (result) {
        options.onResult(result[0].transcript, result.isFinal)
      }
    }

    this.recognition.onend = () => {
      options.onEnd()
    }

    this.recognition.onerror = (e: any) => {
      options.onError(e.error || 'Unknown error')
    }

    try {
      this.recognition.start()
    } catch (e) {
      options.onError('Failed to start recognition')
    }
  }

  stopListening() {
    try {
      this.recognition?.stop()
    } catch {
      // ignore
    }
    this.recognition = null
  }

  speak(text: string, lang?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.synthesis) {
        reject(new Error('SpeechSynthesis not supported'))
        return
      }

      // Cancel any ongoing speech
      this.synthesis.cancel()

      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = lang || this.detectLanguage(text)
      utterance.rate = 1.0
      utterance.pitch = 1.0
      utterance.onend = () => resolve()
      utterance.onerror = () => reject(new Error('Speech synthesis error'))
      this.synthesis.speak(utterance)
    })
  }

  stopSpeaking() {
    this.synthesis?.cancel()
  }
}

export const voiceService = new VoiceService()
