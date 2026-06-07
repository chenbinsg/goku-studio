import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from './locales/zh.json'
import en from './locales/en.json'
import ja from './locales/ja.json'

const STORAGE_KEY = 'aios_language'

export type LangCode = 'zh' | 'en' | 'ja'

export const LANGUAGES: { code: LangCode; label: string; nativeLabel: string }[] = [
  { code: 'zh', label: 'Chinese', nativeLabel: '中文' },
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'ja', label: 'Japanese', nativeLabel: '日本語' },
]

const savedLang = (localStorage.getItem(STORAGE_KEY) as LangCode) || 'zh'

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
    ja: { translation: ja },
  },
  lng: savedLang,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export function setLanguage(lang: LangCode) {
  i18n.changeLanguage(lang)
  localStorage.setItem(STORAGE_KEY, lang)
}

export function getCurrentLang(): LangCode {
  return (i18n.language as LangCode) || 'zh'
}

/** Pick the localized agent display name from name_i18n, falling back to name. */
export function getAgentName(
  agent: { name: string; name_i18n?: Record<string, string> | null },
  lang?: LangCode,
): string {
  const locale = lang ?? getCurrentLang()
  return agent.name_i18n?.[locale] || agent.name
}

export default i18n
