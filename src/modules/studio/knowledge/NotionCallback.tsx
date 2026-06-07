import { useEffect, useState } from 'react'
import { Result, Spin } from 'antd'
import { useSearchParams } from 'react-router-dom'
import { externalMemoryApi } from '@/api'
import { useTranslation } from 'react-i18next'

/**
 * OAuth2 callback page for Notion integration.
 * Opened as a popup from ExternalSources.tsx.
 * On success, posts a message to the opener and closes itself.
 */
export default function NotionCallback() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    const code = searchParams.get('code')
    const error = searchParams.get('error')

    if (error || !code) {
      setError(error || t('notion_callback_no_code'))
      setStatus('error')
      return
    }

    const redirectUri = sessionStorage.getItem('notion_redirect_uri')
      || `${window.location.origin}/knowledge/notion-callback`

    externalMemoryApi.notionCallback({ code, redirect_uri: redirectUri })
      .then(() => {
        setStatus('success')
        // Notify the opener
        window.opener?.postMessage({ type: 'notion_oauth_success' }, window.location.origin)
        setTimeout(() => window.close(), 1500)
      })
      .catch((e: any) => {
        setError(e?.response?.data?.detail || t('notion_callback_exchange_failed'))
        setStatus('error')
      })
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  if (status === 'loading') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Spin size="large" tip={t('notion_callback_connecting')} />
      </div>
    )
  }

  if (status === 'success') {
    return (
      <Result
        status="success"
        title={t('notion_callback_success_title')}
        subTitle={t('notion_callback_success_subtitle')}
      />
    )
  }

  return (
    <Result
      status="error"
      title={t('notion_callback_error_title')}
      subTitle={error}
    />
  )
}
