import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Button,
  Tag,
  Space,
  Spin,
  Descriptions,
  Typography,
  Drawer,
  Alert,
} from 'antd'
import {
  StopOutlined,
  ReloadOutlined,
  ArrowLeftOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { workflowApi } from '@/api'
import { useTranslation } from 'react-i18next'

const { Title, Text } = Typography

const WorkflowMonitor: React.FC = () => {
  const { t } = useTranslation()

  // Status config — labels resolved via t() at render time
  const STATUS_CONFIG: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
    pending: { color: '#d9d9d9', icon: <ClockCircleOutlined />, label: t('workflow_monitor_status_pending') },
    running: { color: '#1890ff', icon: <LoadingOutlined spin />, label: t('workflow_monitor_status_running') },
    success: { color: '#52c41a', icon: <CheckCircleOutlined />, label: t('workflow_monitor_status_success') },
    failed: { color: '#ff4d4f', icon: <CloseCircleOutlined />, label: t('workflow_monitor_status_failed') },
    skipped: { color: '#bfbfbf', icon: <ClockCircleOutlined />, label: t('workflow_monitor_status_skipped') },
  }

  const { id: workflowId, execId } = useParams<{ id: string; execId: string }>()
  const navigate = useNavigate()
  const [execution, setExecution] = useState<any>(null)
  const [workflow, setWorkflow] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, string>>({})
  const [selectedNode, setSelectedNode] = useState<any>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [nodes, setNodes, onNodesChange] = useNodesState<any>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<any>([])
  const sseRef = useRef<EventSource | null>(null)

  const dagToReactFlow = useCallback((dag: any, statusMap: Record<string, string>, nodeExecutions: any[] = []) => {
    const dagNodes: any[] = dag?.nodes || []
    const nodeById = new Map(dagNodes.map((node: any) => [node.id, node]))
    const executionByNodeId = new Map(nodeExecutions.map((ne: any) => [ne.node_id, ne]))
    const edgesByKey = new Map<string, any>()

    ;(dag?.edges || []).forEach((edge: any) => {
      if (!edge?.from || !edge?.to) return
      edgesByKey.set(`${edge.from}->${edge.to}`, edge)
    })
    dagNodes.forEach((node: any) => {
      ;(node.depends_on || []).forEach((sourceId: string) => {
        edgesByKey.set(`${sourceId}->${node.id}`, { from: sourceId, to: node.id })
      })
    })

    const graphEdges = Array.from(edgesByKey.values()).filter(
      (edge: any) => nodeById.has(edge.from) && nodeById.has(edge.to),
    )

    const children = new Map<string, string[]>()
    const inDegree = new Map<string, number>()
    dagNodes.forEach((node: any) => {
      children.set(node.id, [])
      inDegree.set(node.id, 0)
    })
    graphEdges.forEach((edge: any) => {
      children.get(edge.from)?.push(edge.to)
      inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1)
    })

    const labelOrder = (node: any) => {
      const text = `${node?.data?.label || node?.label || node?.id || ''}`
      const match = text.match(/[①-⑳]|\b(\d+)\b/)
      if (!match) return Number.MAX_SAFE_INTEGER
      const circled = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'.indexOf(match[0])
      return circled >= 0 ? circled + 1 : Number(match[1])
    }

    const compareNodes = (a: string, b: string) => {
      const ea = executionByNodeId.get(a) as any
      const eb = executionByNodeId.get(b) as any
      const layerDelta = (ea?.layer_index ?? 9999) - (eb?.layer_index ?? 9999)
      if (layerDelta !== 0) return layerDelta
      const startA = ea?.started_at ? Date.parse(ea.started_at) : Number.MAX_SAFE_INTEGER
      const startB = eb?.started_at ? Date.parse(eb.started_at) : Number.MAX_SAFE_INTEGER
      if (startA !== startB) return startA - startB
      const labelDelta = labelOrder(nodeById.get(a)) - labelOrder(nodeById.get(b))
      if (labelDelta !== 0) return labelDelta
      return a.localeCompare(b)
    }

    const layers: string[][] = []
    let queue = dagNodes
      .filter((node: any) => (inDegree.get(node.id) || 0) === 0)
      .map((node: any) => node.id)
      .sort(compareNodes)
    const seen = new Set<string>()

    while (queue.length > 0) {
      layers.push(queue)
      queue.forEach((id) => seen.add(id))
      const next: string[] = []
      queue.forEach((id) => {
        ;(children.get(id) || []).forEach((childId) => {
          inDegree.set(childId, (inDegree.get(childId) || 0) - 1)
          if ((inDegree.get(childId) || 0) === 0) next.push(childId)
        })
      })
      queue = Array.from(new Set(next)).sort(compareNodes)
    }

    const leftovers = dagNodes
      .map((node: any) => node.id)
      .filter((id: string) => !seen.has(id))
      .sort(compareNodes)
    if (leftovers.length) layers.push(leftovers)

    const positioned = new Map<string, { x: number; y: number }>()
    const columnGap = 310
    const rowGap = 170
    const minX = 80
    const centerY = 220
    layers.forEach((layer, layerIndex) => {
      const startY = centerY - ((layer.length - 1) * rowGap) / 2
      layer.forEach((id, rowIndex) => {
        positioned.set(id, {
          x: minX + layerIndex * columnGap,
          y: Math.max(40, startY + rowIndex * rowGap),
        })
      })
    })

    const rfNodes = dagNodes.map((node: any, i: number) => {
      const status = statusMap[node.id] || 'pending'
      const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pending
      return {
        id: node.id,
        position: positioned.get(node.id) || { x: i * columnGap, y: centerY },
        data: {
          label: (
            <div style={{ textAlign: 'center', padding: '4px 8px' }}>
              <div>
                {cfg.icon}{' '}
                {node.data?.label || node.label || node.id}
              </div>
              <div style={{ fontSize: 11, color: cfg.color }}>{cfg.label}</div>
            </div>
          ),
        },
        style: {
          background: '#fff',
          border: `2px solid ${cfg.color}`,
          borderRadius: 8,
          padding: 8,
          width: 230,
          minHeight: 92,
          boxShadow:
            status === 'running' ? `0 0 12px ${cfg.color}66` : '0 2px 8px rgba(0,0,0,0.08)',
        },
      }
    })

    const rfEdges = graphEdges.map((edge: any) => ({
      id: `e-${edge.from}-${edge.to}`,
      source: edge.from,
      target: edge.to,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: '#aaa' },
    }))

    return { rfNodes, rfEdges }
  }, [t])

  const loadExecution = useCallback(async () => {
    if (!workflowId || !execId) return
    try {
      const data = await workflowApi.getExecution(workflowId, execId)
      setExecution(data)
      const statusMap: Record<string, string> = {}
      for (const ne of (data.node_executions || [])) {
        statusMap[ne.node_id] = ne.status
      }
      setNodeStatuses(statusMap)
    } catch (e) {
      console.error('Failed to load execution', e)
    }
  }, [workflowId, execId])

  const loadWorkflow = useCallback(async () => {
    if (!workflowId) return
    try {
      const wf = await workflowApi.get(workflowId)
      setWorkflow(wf)
    } catch (e) {
      console.error('Failed to load workflow', e)
    }
  }, [workflowId])

  useEffect(() => {
    Promise.all([loadExecution(), loadWorkflow()]).finally(() => setLoading(false))
  }, [loadExecution, loadWorkflow])

  useEffect(() => {
    if (!workflow?.dag && !execution) return
    const dag = workflow?.dag || {}
    const { rfNodes, rfEdges } = dagToReactFlow(dag, nodeStatuses, execution?.node_executions || [])
    setNodes(rfNodes)
    setEdges(rfEdges)
  }, [workflow, execution, nodeStatuses, setNodes, setEdges, dagToReactFlow])

  useEffect(() => {
    if (!workflowId || !execId) return
    const url = `/api/v1/workflows/${workflowId}/executions/${execId}/events`
    const es = new EventSource(url)
    sseRef.current = es

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data)
        if (
          event.type === 'node_started' ||
          event.type === 'node_completed' ||
          event.type === 'node_failed'
        ) {
          setNodeStatuses((prev) => ({
            ...prev,
            [event.node_id]:
              event.status ||
              (event.type === 'node_started'
                ? 'running'
                : event.type === 'node_completed'
                ? 'success'
                : 'failed'),
          }))
        }
        if (
          ['execution_completed', 'execution_failed', 'execution_cancelled'].includes(event.type)
        ) {
          loadExecution()
          es.close()
        }
      } catch (_e) { /* ignore parse errors from SSE stream */ }
    }

    es.onerror = () => {
      es.close()
    }

    return () => {
      es.close()
      sseRef.current = null
    }
  }, [workflowId, execId, loadExecution])

  const handleCancel = async () => {
    if (!workflowId || !execId) return
    try {
      await workflowApi.cancelExecution(workflowId, execId)
      loadExecution()
    } catch (e) {
      console.error('Failed to cancel execution', e)
    }
  }

  const handleRetry = async () => {
    if (!workflowId || !execId) return
    try {
      const result = await workflowApi.retryFromLayer(
        workflowId,
        execId,
        execution?.resume_from_layer || 0,
      )
      navigate(`/workflows/${workflowId}/executions/${result.new_execution_id}`)
    } catch (e) {
      console.error('Failed to retry execution', e)
    }
  }

  const handleNodeClick = (_: any, node: any) => {
    const ne = execution?.node_executions?.find((n: any) => n.node_id === node.id)
    setSelectedNode({ ...node, execution: ne })
    setDrawerOpen(true)
  }

  const statusTag = () => {
    const s = execution?.status || 'running'
    const colors: Record<string, string> = {
      running: 'processing',
      completed: 'success',
      failed: 'error',
      cancelled: 'default',
      cancelling: 'warning',
      waiting_approval: 'warning',
    }
    return <Tag color={colors[s] || 'default'}>{s}</Tag>
  }

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: '#f5f5f5',
      }}
    >
      {/* Header */}
      <div
        style={{
          background: '#fff',
          padding: '12px 24px',
          borderBottom: '1px solid #f0f0f0',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          flexShrink: 0,
        }}
      >
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => navigate('/workflows')}
          type="text"
        />
        <Title level={5} style={{ margin: 0 }}>
          {t('workflow_monitor_execution_title')}
        </Title>
        {workflow?.name && (
          <Text type="secondary" style={{ fontSize: 13 }}>
            {workflow.name}
          </Text>
        )}
        <Text type="secondary" style={{ fontSize: 12 }}>
          {execId?.slice(0, 8)}...
        </Text>
        {statusTag()}
        <div style={{ flex: 1 }} />
        <Space>
          {execution?.status === 'failed' && (
            <Button icon={<ReloadOutlined />} onClick={handleRetry} type="primary">
              {t('workflow_monitor_retry_button', { layer: execution?.resume_from_layer ?? 0 })}
            </Button>
          )}
          {['running', 'waiting_approval'].includes(execution?.status) && (
            <Button icon={<StopOutlined />} onClick={handleCancel} danger>
              {t('workflow_monitor_cancel_button')}
            </Button>
          )}
        </Space>
      </div>

      {execution?.error_message && (
        <Alert
          message={t('workflow_monitor_error_message', { message: execution.error_message })}
          type="error"
          showIcon
          style={{ margin: '8px 24px', flexShrink: 0 }}
        />
      )}

      {/* DAG visualization */}
      <div style={{ flex: 1, position: 'relative' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={true}
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>

      {/* Node detail drawer */}
      <Drawer
        title={t('workflow_monitor_node_detail_title', { id: selectedNode?.id })}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={480}
      >
        {selectedNode?.execution ? (
          <>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label={t('workflow_monitor_status_label')}>
                <Tag
                  color={
                    STATUS_CONFIG[selectedNode.execution.status]?.color ||
                    '#d9d9d9'
                  }
                >
                  {STATUS_CONFIG[selectedNode.execution.status]?.label ||
                    selectedNode.execution.status}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('workflow_monitor_layer_label')}>
                Layer {selectedNode.execution.layer_index ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label={t('workflow_monitor_started_at_label')}>
                {selectedNode.execution.started_at || '-'}
              </Descriptions.Item>
              <Descriptions.Item label={t('workflow_monitor_completed_at_label')}>
                {selectedNode.execution.completed_at || '-'}
              </Descriptions.Item>
            </Descriptions>
            {selectedNode.execution.output_data && (
              <div style={{ marginTop: 16 }}>
                <Text strong>{t('workflow_monitor_output_label')}</Text>
                <pre
                  style={{
                    background: '#f5f5f5',
                    padding: 12,
                    borderRadius: 4,
                    fontSize: 12,
                    maxHeight: 300,
                    overflow: 'auto',
                    marginTop: 8,
                  }}
                >
                  {JSON.stringify(selectedNode.execution.output_data, null, 2)}
                </pre>
              </div>
            )}
            {selectedNode.execution.error_message && (
              <Alert
                message={selectedNode.execution.error_message}
                type="error"
                showIcon
                style={{ marginTop: 16 }}
              />
            )}
          </>
        ) : (
          <Text type="secondary">{t('workflow_monitor_not_executed')}</Text>
        )}
      </Drawer>
    </div>
  )
}

export default WorkflowMonitor
