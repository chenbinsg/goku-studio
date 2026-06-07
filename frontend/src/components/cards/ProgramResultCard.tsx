import React, { useState } from 'react'
import { Card, Space, Button, Typography, Tag, Tree, message, Alert } from 'antd'
import {
  DownloadOutlined,
  CopyOutlined,
  FolderOutlined,
  FileOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CardMessage, ProgramResultCardData, ProgramFile } from '../../types/card'
import type { DataNode } from 'antd/es/tree'

const { Text } = Typography

const LANG_COLORS: Record<string, string> = {
  python:     '#3572A5',
  javascript: '#f1e05a',
  typescript: '#2b7489',
  go:         '#00ADD8',
  rust:       '#dea584',
  java:       '#b07219',
  shell:      '#89e051',
}

function buildFileTree(files: ProgramFile[]): DataNode[] {
  const root: Record<string, DataNode> = {}

  files.forEach((file, idx) => {
    const parts = file.path.split('/')
    let current = root

    parts.forEach((part, partIdx) => {
      const isLeaf = partIdx === parts.length - 1
      const key    = parts.slice(0, partIdx + 1).join('/')

      if (!current[key]) {
        current[key] = {
          title: isLeaf ? (
            <Space size={4}>
              <FileOutlined style={{ color: LANG_COLORS[file.language] || '#8c8c8c', fontSize: 12 }} />
              <Text style={{ fontSize: 12 }}>{part}</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>({file.lines}行)</Text>
            </Space>
          ) : (
            <Space size={4}>
              <FolderOutlined style={{ color: '#fa8c16', fontSize: 12 }} />
              <Text style={{ fontSize: 12 }}>{part}</Text>
            </Space>
          ),
          key:      isLeaf ? `file:${idx}` : key,
          isLeaf,
          children: isLeaf ? undefined : [],
        }
      }

      if (partIdx < parts.length - 1) {
        // Find parent and add child (handled by dirs map below)
      }
    })
  })

  // Simple flat approach for typical project structures
  const nodes: DataNode[] = []
  const dirs: Record<string, DataNode> = {}

  files.forEach((file, idx) => {
    const parts = file.path.split('/')
    if (parts.length === 1) {
      nodes.push({
        title: (
          <Space size={4}>
            <FileOutlined style={{ color: LANG_COLORS[file.language] || '#8c8c8c', fontSize: 12 }} />
            <Text style={{ fontSize: 12 }}>{file.path}</Text>
            <Text type="secondary" style={{ fontSize: 11 }}>({file.lines}行)</Text>
          </Space>
        ),
        key:    `file:${idx}`,
        isLeaf: true,
      })
    } else {
      const dirName = parts[0]
      if (!dirs[dirName]) {
        dirs[dirName] = {
          title: (
            <Space size={4}>
              <FolderOutlined style={{ color: '#fa8c16', fontSize: 12 }} />
              <Text style={{ fontSize: 12 }}>{dirName}/</Text>
            </Space>
          ),
          key:      `dir:${dirName}`,
          children: [],
        }
        nodes.push(dirs[dirName])
      }
      ;(dirs[dirName].children as DataNode[]).push({
        title: (
          <Space size={4}>
            <FileOutlined style={{ color: LANG_COLORS[file.language] || '#8c8c8c', fontSize: 12 }} />
            <Text style={{ fontSize: 12 }}>{parts.slice(1).join('/')}</Text>
            <Text type="secondary" style={{ fontSize: 11 }}>({file.lines}行)</Text>
          </Space>
        ),
        key:    `file:${idx}`,
        isLeaf: true,
      })
    }
  })

  return nodes
}

interface Props {
  card: CardMessage
  onAction: (cardId: string, actionKey: string, params?: Record<string, any>) => void
}

const ProgramResultCard: React.FC<Props> = ({ card, onAction }) => {
  const { t } = useTranslation()
  const data = card.data as ProgramResultCardData
  const files = data.files || []
  const [selectedFileIdx, setSelectedFileIdx] = useState(0)
  const currentFile = files[selectedFileIdx]

  const handleCopyAll = () => {
    const all = files
      .map(f => `// ===== ${f.path} =====\n${f.content}`)
      .join('\n\n')
    navigator.clipboard.writeText(all).then(() => message.success(t('program_card_copy_success')))
  }

  const handleDownloadZip = () => {
    onAction(card.card_id, 'download_zip', { output_dir: data.output_dir })
    message.info(t('program_card_file_saved_message') + '：' + data.output_dir)
  }

  const handleCopyFile = () => {
    if (currentFile) {
      navigator.clipboard.writeText(currentFile.content).then(() => message.success(t('code_card_copy_success')))
    }
  }

  const treeData = buildFileTree(files)

  const handleTreeSelect = (keys: React.Key[]) => {
    const key = keys[0] as string
    if (key && key.startsWith('file:')) {
      setSelectedFileIdx(parseInt(key.split(':')[1]))
    }
  }

  return (
    <Card
      size="small"
      style={{ margin: '8px 0', border: '1px solid #e8e8e8', borderRadius: 8 }}
      bodyStyle={{ padding: 0 }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        background: 'linear-gradient(90deg, #f6ffed 0%, #e6f7ff 100%)',
        borderBottom: '1px solid #e8e8e8',
        borderRadius: '8px 8px 0 0',
      }}>
        <Space size={8}>
          <Text style={{ fontSize: 18 }}>{data.lang_emoji}</Text>
          <Text strong style={{ fontSize: 14 }}>{t('program_card_title')}</Text>
          <Tag color="success">{data.language}</Tag>
          {data.framework && <Tag color="processing">{data.framework}</Tag>}
        </Space>
        <Space size={4}>
          <Button size="small" type="text" icon={<CopyOutlined />} onClick={handleCopyAll}>
            {t('program_card_copy_all_button')}
          </Button>
          <Button size="small" type="text" icon={<DownloadOutlined />} onClick={handleDownloadZip}>
            {t('program_card_download_zip_button')}
          </Button>
        </Space>
      </div>

      {/* Meta bar */}
      <div style={{
        padding: '6px 14px',
        background: '#fafafa',
        borderBottom: '1px solid #f0f0f0',
      }}>
        <Space size={12} wrap>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('program_card_requirement_label')}：<Text style={{ fontSize: 12 }}>{data.requirement.slice(0, 60)}{data.requirement.length > 60 ? '...' : ''}</Text>
          </Text>
          <Tag>{data.file_count} {t('program_card_file_count')}</Tag>
          <Tag>{data.total_lines.toLocaleString()} {t('program_card_line_count')}</Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('program_card_duration_label')} {data.duration_s}s</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('program_card_run_command_label')}：<code style={{ fontSize: 11, background: '#f5f5f5', padding: '1px 4px', borderRadius: 3 }}>
              {data.run_cmd}
            </code>
          </Text>
        </Space>
      </div>

      {/* Execution result (if available) */}
      {data.exec_result && !data.exec_result.skipped && (
        <div style={{ padding: '8px 14px', borderBottom: '1px solid #f0f0f0' }}>
          <Alert
            type={data.exec_result.success ? 'success' : 'warning'}
            showIcon
            message={
              <Space size={8}>
                {data.exec_result.success
                  ? <><CheckCircleFilled style={{ color: '#52c41a' }} /> {t('program_card_execution_success')}</>
                  : <><CloseCircleFilled style={{ color: '#faad14' }} /> {t('program_card_execution_warning')}</>
                }
              </Space>
            }
            description={
              data.exec_result.stdout || data.exec_result.stderr
                ? <pre style={{ margin: 0, fontSize: 11, maxHeight: 80, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                    {data.exec_result.stdout || data.exec_result.stderr}
                  </pre>
                : undefined
            }
            style={{ padding: '6px 10px' }}
          />
        </div>
      )}

      {/* File tree + code viewer */}
      <div style={{ display: 'flex', minHeight: 280, maxHeight: 420 }}>
        {/* Left: file tree */}
        <div style={{
          width: 180,
          borderRight: '1px solid #f0f0f0',
          padding: '8px 4px',
          overflowY: 'auto',
          flexShrink: 0,
        }}>
          <Tree
            treeData={treeData}
            defaultExpandAll
            selectedKeys={[`file:${selectedFileIdx}`]}
            onSelect={handleTreeSelect}
            showIcon={false}
            style={{ fontSize: 12 }}
          />
        </div>

        {/* Right: code viewer */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {currentFile && (
            <>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '4px 10px',
                background: '#1e1e1e',
                borderBottom: '1px solid #3c3c3c',
              }}>
                <Space size={8}>
                  <Text style={{ color: '#abb2bf', fontSize: 12 }}>{currentFile.path}</Text>
                  <Tag color="default" style={{ fontSize: 10, lineHeight: '16px' }}>
                    {currentFile.language}
                  </Tag>
                </Space>
                <Button
                  size="small"
                  type="text"
                  icon={<CopyOutlined />}
                  style={{ color: '#abb2bf' }}
                  onClick={handleCopyFile}
                />
              </div>
              <pre style={{
                margin: 0,
                flex: 1,
                padding: 12,
                background: '#1e1e1e',
                color: '#abb2bf',
                fontSize: 12,
                fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
                overflow: 'auto',
                lineHeight: 1.6,
                whiteSpace: 'pre',
              }}>
                {currentFile.content}
              </pre>
            </>
          )}
        </div>
      </div>
    </Card>
  )
}

export default ProgramResultCard
