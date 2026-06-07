import React from 'react'
import { Card, Table, Typography, Button } from 'antd'
import { DownloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CardMessage, TableCardData } from '../../types/card'

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
        const val = row[c.dataIndex]
        const str = val == null ? '' : String(val)
        return str.includes(',') ? `"${str}"` : str
      }).join(',')
    )
    const csv = [header, ...rows].join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${data.title || 'export'}.csv`
    a.click()
    URL.revokeObjectURL(url)
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
      title={data.title && <Text strong style={{ fontSize: 13 }}>{data.title} ({data.rows.length} {t('table_card_row_count')})</Text>}
      extra={
        <Button size="small" icon={<DownloadOutlined />} onClick={handleExport}>
          {t('table_card_export_button')}
        </Button>
      }
    >
      <Table
        columns={columns}
        dataSource={data.rows.map((r, i) => ({ ...r, _key: i }))}
        rowKey="_key"
        size="small"
        pagination={data.rows.length > 10 ? { pageSize: data.page_size || 10, size: 'small' } : false}
        scroll={{ x: 'max-content' }}
        style={{ fontSize: 12 }}
      />
    </Card>
  )
}

export default TableCard
