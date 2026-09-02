import React from 'react'
import { Card, Table, Typography, Button } from 'antd'
import { DownloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CardMessage, TableCardData } from '../../types/card'
import CollapsibleBody from './CollapsibleBody'

const { Text } = Typography

interface Props {
  card: CardMessage
  onAction: (cardId: string, actionKey: string, params?: Record<string, any>) => void
}

const TableCard: React.FC<Props> = ({ card }) => {
  const { t } = useTranslation()
  const data = card.data as TableCardData

  const handleExport = () => {
    const header = data.columns.map((c) => c.title).join(',')
    const rows = data.rows.map((row) =>
      data.columns.map((c) => {
        const v = row[c.dataIndex]
        const s = v === null || v === undefined ? '' : String(v)
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s
      }).join(','),
    )
    const csv = [header, ...rows].join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${data.title || 'export'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // A row number, for every table card rather than for one producer: a long
  // list is scanned, and scanning needs somewhere to point ("第 37 条"). It is
  // the position in the current order, so it renumbers when a column is sorted
  // — which is what a reader means by "the 37th row" anyway.
  const indexColumn = {
    key: '_index',
    title: t('table_card_index', '#'),
    width: 52,
    align: 'right' as const,
    render: (_: unknown, __: unknown, i: number) => (
      <Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>{i + 1}</Text>
    ),
  }

  const columns = data.columns.map((col) => ({
    ...col,
    sorter: (a: Record<string, any>, b: Record<string, any>) => {
      const va = a[col.dataIndex]
      const vb = b[col.dataIndex]
      if (typeof va === 'number' && typeof vb === 'number') return va - vb
      return String(va || '').localeCompare(String(vb || ''))
    },
  }))

  return (
    <Card
      size="small"
      style={{ margin: '8px 0' }}
      title={data.title && (
        <Text strong style={{ fontSize: 13 }}>
          {data.title} ({data.rows.length} {t('table_card_row_count')})
        </Text>
      )}
      extra={
        <Button size="small" icon={<DownloadOutlined />} onClick={handleExport}>
          {t('table_card_export_button')}
        </Button>
      }
    >
      {/* Every row renders; the fold is what stops a 130-row table pushing the
          conversation off the screen. Paginating instead would hide rows from
          the browser's own find, which is not the same thing. */}
      <CollapsibleBody>
        <Table
          columns={[indexColumn, ...columns]}
          dataSource={data.rows.map((r, i) => ({ ...r, _key: i }))}
          rowKey="_key"
          size="small"
          pagination={false}
          scroll={{ x: 'max-content' }}
          style={{ fontSize: 12 }}
        />
      </CollapsibleBody>
    </Card>
  )
}

export default TableCard
