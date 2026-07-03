import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlow,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  MarkerType,
  Handle,
  Position,
  Panel,
  useReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Button,
  Input,
  Card,
  Form,
  Select,
  InputNumber,
  Drawer,
  Space,
  Typography,
  message,
  Tag,
  Divider,
  Badge,
  Tooltip,
} from 'antd'
import {
  PlusOutlined,
  SaveOutlined,
  PlayCircleOutlined,
  ArrowLeftOutlined,
  DeleteOutlined,
  RobotOutlined,
  BranchesOutlined,
  ForkOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  StopOutlined,
  LoadingOutlined,
  ApiOutlined,
  CodeOutlined,
  HolderOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { workflowApi, toolApi, agentApi } from '@/api'
import { useTranslation } from 'react-i18next'

const { Text } = Typography

// ─── Types ────────────────────────────────────────────────────────────────────

type NodeType = 'task' | 'condition' | 'code' | 'parallel' | 'approval' | 'wait' | 'http_request' | 'start' | 'end'

interface NodeData {
  label: string
  // task
  prompt?: string
  model?: string
  timeout?: number
  tools?: string[]
  use_agent?: boolean
  // condition
  expression?: string
  description?: string
  // approval
  risk_level?: number
  timeout_seconds?: number
  // wait
  seconds?: number
  // http_request
  method?: string
  url?: string
  headers?: string
  body?: string
  output_variable?: string
  http_timeout?: number
  // execution status overlay (injected at runtime, not persisted)
  _execStatus?: string
  [key: string]: unknown
}

// ─── Color palette ────────────────────────────────────────────────────────────

const EXEC_STATUS_COLOR: Record<string, string> = {
  running:  '#1677ff',
  success:  '#52c41a',
  failed:   '#ff4d4f',
  skipped:  '#bfbfbf',
  pending:  '#d9d9d9',
}

const NODE_COLORS: Record<string, string> = {
  start:        '#52c41a',
  end:          '#f5222d',
  task:         '#1677ff',
  condition:    '#faad14',
  code:         '#531dab',
  parallel:     '#722ed1',
  approval:     '#fa8c16',
  wait:         '#8c8c8c',
  http_request: '#13c2c2',
}

// ─── Shared node wrapper ──────────────────────────────────────────────────────

interface NodeWrapperProps {
  color: string
  selected: boolean
  children: React.ReactNode
  minWidth?: number
  execStatus?: string
}

const NodeWrapper: React.FC<NodeWrapperProps> = ({ color, selected, children, minWidth = 140, execStatus }) => {
  const dotColor = execStatus ? (EXEC_STATUS_COLOR[execStatus] ?? '#d9d9d9') : null
  return (
    <div style={{ position: 'relative' }}>
      {dotColor && (
        <div
          title={execStatus}
          style={{
            position: 'absolute', top: -7, right: -7,
            width: 14, height: 14, borderRadius: '50%',
            background: dotColor, border: '2px solid #fff',
            boxShadow: '0 1px 4px rgba(0,0,0,0.25)', zIndex: 10,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          {execStatus === 'running' && <LoadingOutlined style={{ fontSize: 8, color: '#fff' }} />}
        </div>
      )}
      <div
        style={{
          padding: '10px 14px', borderRadius: 8, background: '#fff',
          border: `2px solid ${execStatus === 'running' ? '#1677ff' : selected ? '#ff4d4f' : color}`,
          minWidth,
          boxShadow: selected
            ? `0 0 0 3px ${color}33, 0 2px 10px rgba(0,0,0,0.15)`
            : execStatus === 'running'
              ? '0 0 0 3px #1677ff33, 0 2px 10px rgba(0,0,0,0.1)'
              : '0 2px 8px rgba(0,0,0,0.1)',
          transition: 'box-shadow 0.2s, border-color 0.2s',
        }}
      >
        {children}
      </div>
    </div>
  )
}

// ─── Custom Node Components ───────────────────────────────────────────────────

const StartNode: React.FC<NodeProps> = ({ data }) => (
  <div style={{
    padding: '10px 24px', borderRadius: 24,
    background: NODE_COLORS.start, color: '#fff',
    fontWeight: 700, textAlign: 'center', minWidth: 80,
    boxShadow: '0 2px 8px rgba(82,196,26,0.3)',
  }}>
    {(data as NodeData).label || 'Start'}
    <Handle type="source" position={Position.Bottom} />
  </div>
)

const EndNode: React.FC<NodeProps> = ({ data }) => (
  <div style={{
    padding: '10px 24px', borderRadius: 24,
    background: NODE_COLORS.end, color: '#fff',
    fontWeight: 700, textAlign: 'center', minWidth: 80,
    boxShadow: '0 2px 8px rgba(245,34,45,0.3)',
  }}>
    {(data as NodeData).label || 'End'}
    <Handle type="target" position={Position.Top} />
  </div>
)

const TaskNode: React.FC<NodeProps> = ({ data, selected }) => (
  <NodeWrapper color={NODE_COLORS.task} selected={!!selected} execStatus={(data as NodeData)._execStatus}>
    <Handle type="target" position={Position.Top} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <RobotOutlined style={{ color: NODE_COLORS.task, fontSize: 14 }} />
      <span style={{ fontWeight: 600, fontSize: 13 }}>{(data as NodeData).label || 'Task'}</span>
    </div>
    <Tag color="blue" style={{ fontSize: 10 }}>{(data as NodeData).model || 'default'}</Tag>
    {(data as NodeData).prompt && (
      <div style={{ fontSize: 11, color: '#888', marginTop: 4, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {(data as NodeData).prompt as string}
      </div>
    )}
    <Handle type="source" position={Position.Bottom} />
  </NodeWrapper>
)

const ConditionNode: React.FC<NodeProps> = ({ data, selected }) => (
  <NodeWrapper color={NODE_COLORS.condition} selected={!!selected} minWidth={160} execStatus={(data as NodeData)._execStatus}>
    <Handle type="target" position={Position.Top} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <BranchesOutlined style={{ color: NODE_COLORS.condition, fontSize: 14 }} />
      <span style={{ fontWeight: 600, fontSize: 13 }}>{(data as NodeData).label || 'Condition'}</span>
    </div>
    {(data as NodeData).expression && (
      <Text type="secondary" style={{ fontSize: 11 }}>{(data as NodeData).expression as string}</Text>
    )}
    <Handle type="source" position={Position.Bottom} id="true"  style={{ left: '30%' }} />
    <Handle type="source" position={Position.Bottom} id="false" style={{ left: '70%' }} />
    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10, color: '#888' }}>
      <span style={{ marginLeft: 4 }}>true</span>
      <span style={{ marginRight: 4 }}>false</span>
    </div>
  </NodeWrapper>
)

const ParallelNode: React.FC<NodeProps> = ({ data, selected }) => (
  <NodeWrapper color={NODE_COLORS.parallel} selected={!!selected} execStatus={(data as NodeData)._execStatus}>
    <Handle type="target" position={Position.Top} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <ForkOutlined style={{ color: NODE_COLORS.parallel, fontSize: 14 }} />
      <span style={{ fontWeight: 600, fontSize: 13 }}>{(data as NodeData).label || 'Parallel'}</span>
    </div>
    <Tag color="purple" style={{ fontSize: 10 }}>fork</Tag>
    {(data as NodeData).description && (
      <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{(data as NodeData).description as string}</div>
    )}
    <Handle type="source" position={Position.Bottom} />
  </NodeWrapper>
)

const ApprovalNode: React.FC<NodeProps> = ({ data, selected }) => {
  const riskColors = ['', 'green', 'orange', 'red']
  const riskLevel = (data as NodeData).risk_level as number | undefined
  return (
    <NodeWrapper color={NODE_COLORS.approval} selected={!!selected} execStatus={(data as NodeData)._execStatus}>
      <Handle type="target" position={Position.Top} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <CheckCircleOutlined style={{ color: NODE_COLORS.approval, fontSize: 14 }} />
        <span style={{ fontWeight: 600, fontSize: 13 }}>{(data as NodeData).label || 'Approval'}</span>
      </div>
      <Tag color="orange" style={{ fontSize: 10 }}>human approval</Tag>
      {riskLevel !== undefined && (
        <Tag color={riskColors[riskLevel] || 'default'} style={{ fontSize: 10, marginLeft: 4 }}>risk {riskLevel}</Tag>
      )}
      <Handle type="source" position={Position.Bottom} />
    </NodeWrapper>
  )
}

const WaitNode: React.FC<NodeProps> = ({ data, selected }) => (
  <NodeWrapper color={NODE_COLORS.wait} selected={!!selected} execStatus={(data as NodeData)._execStatus}>
    <Handle type="target" position={Position.Top} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <ClockCircleOutlined style={{ color: NODE_COLORS.wait, fontSize: 14 }} />
      <span style={{ fontWeight: 600, fontSize: 13 }}>{(data as NodeData).label || 'Wait'}</span>
    </div>
    <Tag color="default" style={{ fontSize: 10 }}>
      {(data as NodeData).seconds !== undefined ? `${(data as NodeData).seconds}s` : 'delay'}
    </Tag>
    <Handle type="source" position={Position.Bottom} />
  </NodeWrapper>
)

const HttpRequestNode: React.FC<NodeProps> = ({ data, selected }) => (
  <NodeWrapper color={NODE_COLORS.http_request} selected={!!selected} execStatus={(data as NodeData)._execStatus}>
    <Handle type="target" position={Position.Top} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <ApiOutlined style={{ color: NODE_COLORS.http_request, fontSize: 14 }} />
      <span style={{ fontWeight: 600, fontSize: 13 }}>{(data as NodeData).label || 'HTTP Request'}</span>
    </div>
    <Tag color="cyan" style={{ fontSize: 10 }}>{(data as NodeData).method || 'GET'}</Tag>
    {(data as NodeData).url && (
      <div style={{ fontSize: 11, color: '#888', marginTop: 4, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {(data as NodeData).url as string}
      </div>
    )}
    <Handle type="source" position={Position.Bottom} />
  </NodeWrapper>
)

const CodeNode: React.FC<NodeProps> = ({ data, selected }) => (
  <NodeWrapper color={NODE_COLORS.code} selected={!!selected} execStatus={(data as NodeData)._execStatus}>
    <Handle type="target" position={Position.Top} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <CodeOutlined style={{ color: NODE_COLORS.code, fontSize: 14 }} />
      <span style={{ fontWeight: 600, fontSize: 13 }}>{(data as NodeData).label || 'Code'}</span>
    </div>
    {(data as NodeData).output_variable && (
      <Tag color="purple" style={{ fontSize: 10 }}>→ {(data as NodeData).output_variable as string}</Tag>
    )}
    <Handle type="source" position={Position.Bottom} />
  </NodeWrapper>
)

const nodeTypes: NodeTypes = {
  start:        StartNode,
  end:          EndNode,
  task:         TaskNode,
  condition:    ConditionNode,
  code:         CodeNode,
  parallel:     ParallelNode,
  approval:     ApprovalNode,
  wait:         WaitNode,
  http_request: HttpRequestNode,
}

// ─── DAG serialization helpers ────────────────────────────────────────────────

interface DagNode {
  id: string
  type: string
  label: string
  position?: { x: number; y: number }
  config: Record<string, unknown>
  depends_on: string[]
}

interface DagData {
  nodes: DagNode[]
}

function rfToDag(nodes: Node[], edges: Edge[]): DagData {
  const dependsMap: Record<string, string[]> = {}
  nodes.forEach((n) => { dependsMap[n.id] = [] })
  edges.forEach((e) => {
    if (dependsMap[e.target]) dependsMap[e.target].push(e.source)
    else dependsMap[e.target] = [e.source]
  })
  const dagNodes: DagNode[] = nodes.map((n) => {
    const d = n.data as NodeData
    const { label, _execStatus, ...config } = d
    return {
      id: n.id,
      type: n.type || 'task',
      label: label || n.id,
      position: n.position,
      config: config as Record<string, unknown>,
      depends_on: dependsMap[n.id] || [],
    }
  })
  return { nodes: dagNodes }
}

function dagToRf(dag: DagData): { nodes: Node[]; edges: Edge[] } {
  const rfNodes: Node[] = []
  const rfEdges: Edge[] = []

  const visibleDagNodes = dag.nodes.filter((dn) => dn.id !== 'send_email')
  const visibleNodeIds = new Set(visibleDagNodes.map((dn) => dn.id))

  // Support both depends_on and edges formats
  const edgeList: Array<{ from: string; to: string }> = ((dag as any).edges || [])
    .filter((e: any) => visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to))
  visibleDagNodes.forEach((dn) => {
    const pos = dn.position || { x: 200 + Math.random() * 300, y: 100 + Math.random() * 300 }
    rfNodes.push({
      id: dn.id,
      type: dn.type,
      position: pos,
      data: { label: dn.label, ...(dn.config || {}) } as NodeData,
    })
    ;(dn.depends_on || []).filter((dep) => visibleNodeIds.has(dep)).forEach((dep) => {
      rfEdges.push({
        id: `${dep}-${dn.id}`,
        source: dep,
        target: dn.id,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 2 },
      })
    })
  })
  edgeList.forEach((e) => {
    const eid = `${e.from}-${e.to}`
    if (!rfEdges.find((ex) => ex.id === eid)) {
      rfEdges.push({
        id: eid, source: e.from, target: e.to,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 2 },
      })
    }
  })
  return { nodes: rfNodes, edges: rfEdges }
}

// ─── Default nodes / palette config ──────────────────────────────────────────

const defaultNodes: Node[] = [
  { id: 'start', type: 'start', position: { x: 250, y: 50 },  data: { label: 'Start' } },
  { id: 'end',   type: 'end',   position: { x: 250, y: 420 }, data: { label: 'End'   } },
]

const defaultEdges: Edge[] = [{
  id: 'start-end', source: 'start', target: 'end',
  markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 2 },
}]

const DEFAULT_NODE_DATA: Record<string, Partial<NodeData>> = {
  task:         { label: 'New Task',    model: 'claude-3-5-sonnet', prompt: '', timeout: 300 },
  condition:    { label: 'Condition',   expression: "result.status == 'success'", description: '' },
  parallel:     { label: 'Parallel',   description: '' },
  approval:     { label: 'Approval',   description: '', risk_level: 1, timeout_seconds: 3600 },
  wait:         { label: 'Wait',       seconds: 30 },
  http_request: { label: 'HTTP Request', method: 'GET', url: '', headers: '', body: '', output_variable: '', http_timeout: 30 },
}

// ─── Inner designer (must be inside ReactFlowProvider) ───────────────────────

const WorkflowDesignerInner: React.FC = () => {
  const { t } = useTranslation()
  const navigate    = useNavigate()
  const { id: routeId } = useParams<{ id: string }>()
  const [searchParams]  = useSearchParams()
  const workflowId = routeId || searchParams.get('id') || null

  const [nodes, setNodes, onNodesChange] = useNodesState(defaultNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(defaultEdges)
  const [workflowName, setWorkflowName] = useState('')
  const [workflowDesc, setWorkflowDesc] = useState('')
  const [workflowAgentId, setWorkflowAgentId] = useState<string | undefined>(undefined)
  const [availableAgents, setAvailableAgents] = useState<{ id: string; name: string }[]>([])
  const [saving,   setSaving]   = useState(false)
  const [running,  setRunning]  = useState(false)
  const [loading,  setLoading]  = useState(false)
  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [drawerOpen, setDrawerOpen]     = useState(false)
  const [nodeForm] = Form.useForm()
  const nodeIdCounter  = useRef(100)
  const savedWorkflowId = useRef<string | null>(workflowId)
  const [availableTools, setAvailableTools] = useState<{ name: string; description: string }[]>([])
  const [executionId,     setExecutionId]     = useState<string | null>(null)
  const [executionStatus, setExecutionStatus] = useState<string | null>(null)
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, string>>({})
  const pollTimerRef       = useRef<NodeJS.Timeout | null>(null)
  const reactFlowWrapper   = useRef<HTMLDivElement>(null)
  const { screenToFlowPosition } = useReactFlow()

  // ── Load tools ──────────────────────────────────────────────────────────────
  useEffect(() => {
    toolApi.list().then((res: any) => {
      const tools = Array.isArray(res) ? res : (res?.tools || [])
      setAvailableTools(tools.map((t: any) => ({ name: t.name, description: t.description || '' })))
    }).catch(() => {})
  }, [])

  // ── Load agents (for the workflow ↔ agent binding selector) ──────────────────
  useEffect(() => {
    agentApi.list({ size: 200, is_active: true }).then((res: any) => {
      const items = res?.items || []
      setAvailableAgents(items.map((a: any) => ({ id: a.id, name: a.name })))
    }).catch(() => {})
  }, [])

  // ── Poll execution status ───────────────────────────────────────────────────
  useEffect(() => {
    if (!executionId || !savedWorkflowId.current) return
    const TERMINAL = ['completed', 'failed', 'cancelled']
    const poll = async () => {
      try {
        const exec = await workflowApi.getExecution(savedWorkflowId.current!, executionId)
        setExecutionStatus(exec.status)
        if (Array.isArray(exec.node_executions)) {
          const statuses: Record<string, string> = {}
          exec.node_executions.forEach((ne: any) => {
            if (ne.node_id) statuses[ne.node_id] = ne.status || 'pending'
          })
          setNodeStatuses(statuses)
        }
        if (TERMINAL.includes(exec.status)) {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
          setRunning(false)
          if (exec.status === 'completed') message.success(t('workflow_designer_completed'))
          else if (exec.status === 'failed') message.error(`${t('workflow_designer_run_failed')}: ${exec.error_message || ''}`)
        }
      } catch { /* keep retrying */ }
    }
    poll()
    pollTimerRef.current = setInterval(poll, 2000)
    return () => { if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null } }
  }, [executionId, t]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (Object.keys(nodeStatuses).length === 0) return
    setNodes((nds) =>
      nds.map((n) => nodeStatuses[n.id] !== undefined
        ? { ...n, data: { ...n.data, _execStatus: nodeStatuses[n.id] } as NodeData }
        : n,
      ),
    )
  }, [nodeStatuses, setNodes])

  useEffect(() => {
    return () => { if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null } }
  }, [])

  // ── Load existing workflow ──────────────────────────────────────────────────
  useEffect(() => {
    if (!workflowId) return
    setLoading(true)
    workflowApi.get(workflowId).then((wf: any) => {
      setWorkflowName(wf.name || '')
      setWorkflowDesc(wf.description || '')
      setWorkflowAgentId(wf.agent_id || undefined)
      if (wf.dag?.nodes?.length > 0) {
        const { nodes: rfNodes, edges: rfEdges } = dagToRf(wf.dag as DagData)
        setNodes(rfNodes)
        setEdges(rfEdges)
      }
    }).catch(() => message.error(t('workflow_designer_load_failed')))
      .finally(() => setLoading(false))
  }, [workflowId, setNodes, setEdges, t])

  // ── Edge connect ────────────────────────────────────────────────────────────
  const onConnect = useCallback(
    (params: Connection) =>
      setEdges((eds) => addEdge({ ...params, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 2 } }, eds)),
    [setEdges],
  )

  // ── Add node at position (click palette +) ─────────────────────────────────
  const addNode = (type: NodeType, position?: { x: number; y: number }) => {
    const newId = `${type}_${nodeIdCounter.current++}`
    const pos   = position ?? { x: 220 + Math.random() * 120, y: 160 + Math.random() * 160 }
    setNodes((nds) => [...nds, {
      id: newId, type, position: pos,
      data: { ...(DEFAULT_NODE_DATA[type] || { label: type }) } as NodeData,
    }])
  }

  // ── Drag-and-drop: palette → canvas ────────────────────────────────────────
  const onDragStart = (event: React.DragEvent, type: NodeType) => {
    event.dataTransfer.setData('application/aios-node-type', type)
    event.dataTransfer.effectAllowed = 'move'
  }

  const onDragOver = (event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const type = event.dataTransfer.getData('application/aios-node-type') as NodeType
      if (!type) return
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      addNode(type, position)
    },
    [screenToFlowPosition], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // ── Node click → properties drawer ─────────────────────────────────────────
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.type === 'start' || node.type === 'end') return
      setSelectedNode(node)
      const d = node.data as NodeData
      nodeForm.setFieldsValue({
        label:           d.label            || '',
        prompt:          d.prompt           || '',
        model:           d.model            || 'claude-3-5-sonnet',
        timeout:         d.timeout          ?? 300,
        tools:           d.tools            || [],
        expression:      d.expression       || '',
        description:     d.description      || '',
        risk_level:      d.risk_level       ?? 1,
        timeout_seconds: d.timeout_seconds  ?? 3600,
        seconds:         d.seconds          ?? 30,
        method:          d.method           || 'GET',
        url:             d.url              || '',
        headers:         d.headers          || '',
        body:            d.body             || '',
        output_variable: d.output_variable  || '',
        http_timeout:    d.http_timeout     ?? 30,
      })
      setDrawerOpen(true)
    },
    [nodeForm],
  )

  // ── Apply node property updates ─────────────────────────────────────────────
  const handleUpdateNode = () => {
    if (!selectedNode) return
    const values = nodeForm.getFieldsValue()
    setNodes((nds) => nds.map((n) =>
      n.id === selectedNode.id ? { ...n, data: { ...n.data, ...values } as NodeData } : n,
    ))
    setDrawerOpen(false)
    setSelectedNode(null)
  }

  // ── Delete selected node ────────────────────────────────────────────────────
  const handleDeleteNode = () => {
    if (!selectedNode) return
    setNodes((nds) => nds.filter((n) => n.id !== selectedNode.id))
    setEdges((eds) => eds.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id))
    setDrawerOpen(false)
    setSelectedNode(null)
  }

  // ── Save ────────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!workflowName.trim()) { message.warning(t('workflow_designer_save_name_warning')); return }
    setSaving(true)
    try {
      const dag     = rfToDag(nodes, edges)
      const payload = { name: workflowName, description: workflowDesc, dag, triggers: [{ type: 'manual' }], variables: {}, agent_id: workflowAgentId ?? null }
      if (savedWorkflowId.current) {
        await workflowApi.update(savedWorkflowId.current, payload)
        message.success(t('workflow_designer_save_success'))
      } else {
        const res = await workflowApi.create(payload)
        savedWorkflowId.current = (res as any).workflow_id || null
        message.success(t('workflow_designer_create_success'))
      }
    } catch {
      message.error(t('workflow_designer_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  // ── Run ─────────────────────────────────────────────────────────────────────
  const handleRun = async () => {
    if (!savedWorkflowId.current) { message.warning(t('workflow_designer_run_save_first')); return }
    setRunning(true); setExecutionStatus('running'); setExecutionId(null); setNodeStatuses({})
    setNodes((nds) => nds.map((n) => { const { _execStatus, ...rest } = n.data as NodeData; return { ...n, data: rest as NodeData } }))
    try {
      const res = await workflowApi.execute(savedWorkflowId.current)
      setExecutionId((res as any).execution_id || null)
      message.info(t('workflow_designer_run_started'))
    } catch {
      message.error(t('workflow_designer_run_failed'))
      setRunning(false); setExecutionStatus(null)
    }
  }

  const handleCancel = async () => {
    if (!savedWorkflowId.current || !executionId) return
    try {
      await workflowApi.cancelExecution(savedWorkflowId.current, executionId)
      message.info(t('workflow_designer_cancel_requested'))
    } catch {
      message.error(t('workflow_designer_cancel_failed'))
    }
  }

  // ── Palette items (i18n labels set at render time) ─────────────────────────
  type PaletteItem = { type: NodeType; labelKey: string; icon: React.ReactNode; color: string }
  const PALETTE_ITEMS: PaletteItem[] = [
    { type: 'task',         labelKey: 'workflow_designer_node_task',      icon: <RobotOutlined />,       color: NODE_COLORS.task },
    { type: 'condition',    labelKey: 'workflow_designer_node_condition',  icon: <BranchesOutlined />,    color: NODE_COLORS.condition },
    { type: 'code',         labelKey: 'workflow_designer_node_code',       icon: <CodeOutlined />,        color: NODE_COLORS.code },
    { type: 'parallel',     labelKey: 'workflow_designer_node_parallel',   icon: <ForkOutlined />,        color: NODE_COLORS.parallel },
    { type: 'approval',     labelKey: 'workflow_designer_node_approval',   icon: <CheckCircleOutlined />, color: NODE_COLORS.approval },
    { type: 'wait',         labelKey: 'workflow_designer_node_wait',       icon: <ClockCircleOutlined />, color: NODE_COLORS.wait },
    { type: 'http_request', labelKey: 'workflow_designer_node_http',       icon: <ApiOutlined />,         color: NODE_COLORS.http_request },
  ]

  // ── Properties drawer form fields ───────────────────────────────────────────
  const renderFormFields = () => {
    const type = selectedNode?.type
    return (
      <>
        <Form.Item label={t('workflow_designer_label')} name="label" rules={[{ required: true, message: t('workflow_designer_label_required') }]}>
          <Input />
        </Form.Item>

        {type === 'task' && (
          <>
            <Form.Item label={t('workflow_designer_prompt')} name="prompt">
              <Input.TextArea rows={4} placeholder={t('workflow_designer_prompt_placeholder')} />
            </Form.Item>
            <Form.Item label={t('workflow_designer_tools')} name="tools" extra={t('workflow_designer_tools_hint')}>
              <Select
                mode="multiple" allowClear showSearch
                placeholder={t('workflow_designer_tools_placeholder')}
                optionFilterProp="label"
                options={availableTools.map((tool) => ({ label: tool.name, value: tool.name, title: tool.description }))}
                maxTagCount={4}
                maxTagPlaceholder={(omitted) => `+${omitted.length} more`}
              />
            </Form.Item>
            <Form.Item label={t('workflow_designer_model')} name="model">
              <Select options={[
                { label: 'Claude 3.5 Sonnet', value: 'claude-3-5-sonnet' },
                { label: 'Claude 3 Opus',     value: 'claude-3-opus' },
                { label: 'Claude 3 Haiku',    value: 'claude-3-haiku' },
                { label: 'GPT-4o',            value: 'gpt-4o' },
                { label: 'GPT-4o Mini',       value: 'gpt-4o-mini' },
                { label: 'Gemini 1.5 Pro',    value: 'gemini-1.5-pro' },
              ]} />
            </Form.Item>
            <Form.Item label={t('workflow_designer_timeout')} name="timeout">
              <InputNumber min={1} max={86400} style={{ width: '100%' }} />
            </Form.Item>
          </>
        )}

        {type === 'condition' && (
          <>
            <Form.Item label={t('workflow_designer_expression')} name="expression" extra={t('workflow_designer_expression_hint')}>
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item label={t('workflow_designer_description')} name="description">
              <Input.TextArea rows={2} />
            </Form.Item>
          </>
        )}

        {type === 'parallel' && (
          <Form.Item label={t('workflow_designer_description')} name="description">
            <Input.TextArea rows={2} />
          </Form.Item>
        )}

        {type === 'approval' && (
          <>
            <Form.Item label={t('workflow_designer_description')} name="description">
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item label={t('workflow_designer_risk_level')} name="risk_level">
              <Select options={[
                { label: t('workflow_designer_risk_low'),    value: 1 },
                { label: t('workflow_designer_risk_medium'), value: 2 },
                { label: t('workflow_designer_risk_high'),   value: 3 },
              ]} />
            </Form.Item>
            <Form.Item label={t('workflow_designer_timeout')} name="timeout_seconds">
              <InputNumber min={1} max={604800} style={{ width: '100%' }} />
            </Form.Item>
          </>
        )}

        {type === 'wait' && (
          <Form.Item label={t('workflow_designer_wait_seconds')} name="seconds">
            <InputNumber min={1} max={86400} style={{ width: '100%' }} />
          </Form.Item>
        )}

        {type === 'code' && (
          <>
            <Form.Item
              label="Python 代码"
              name="code"
              extra="可用 _vars 读取上游变量，写入 _output 传递给下游节点"
            >
              <Input.TextArea
                rows={10}
                placeholder={`# 示例：关键词扫描\ntext = _vars.get("call_transcript", "")\nkeywords = ["关键词1", "关键词2"]\nhits = [kw for kw in keywords if kw in text]\n_output["hit_count"] = len(hits)\n_output["hits"] = hits\n_output["severity"] = "异常" if hits else "正常"`}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
            </Form.Item>
            <Form.Item
              label="输出变量名"
              name="output_variable"
              extra="可选：将 _output 整体存入此工作流变量"
            >
              <Input placeholder="scan_result" />
            </Form.Item>
            <Form.Item label="超时（秒）" name="timeout">
              <InputNumber min={1} max={300} style={{ width: '100%' }} />
            </Form.Item>
          </>
        )}

        {type === 'http_request' && (
          <>
            <Form.Item label={t('workflow_designer_http_method')} name="method">
              <Select options={[
                { label: 'GET',    value: 'GET' },
                { label: 'POST',   value: 'POST' },
                { label: 'PUT',    value: 'PUT' },
                { label: 'PATCH',  value: 'PATCH' },
                { label: 'DELETE', value: 'DELETE' },
              ]} />
            </Form.Item>
            <Form.Item label={t('workflow_designer_http_url')} name="url" rules={[{ required: true, message: t('workflow_designer_label_required') }]}>
              <Input placeholder="https://api.example.com/endpoint" />
            </Form.Item>
            <Form.Item label={t('workflow_designer_http_headers')} name="headers" extra={t('workflow_designer_http_headers_hint')}>
              <Input.TextArea rows={3} placeholder={'{\n  "Authorization": "Bearer …"\n}'} style={{ fontFamily: 'monospace', fontSize: 12 }} />
            </Form.Item>
            <Form.Item label={t('workflow_designer_http_body')} name="body">
              <Input.TextArea rows={4} placeholder={'{\n  "key": "value"\n}'} style={{ fontFamily: 'monospace', fontSize: 12 }} />
            </Form.Item>
            <Form.Item label={t('workflow_designer_http_output_var')} name="output_variable" extra={t('workflow_designer_http_output_var_hint')}>
              <Input placeholder="api_response" />
            </Form.Item>
            <Form.Item label={t('workflow_designer_http_timeout')} name="http_timeout">
              <InputNumber min={1} max={300} style={{ width: '100%' }} />
            </Form.Item>
          </>
        )}
      </>
    )
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ height: 'calc(100vh - 120px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Text type="secondary">{t('workflow_designer_loading')}</Text>
      </div>
    )
  }

  return (
    <div style={{ height: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column' }}>

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div style={{ padding: '10px 4px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/workflows')}>
          {t('workflow_designer_back')}
        </Button>
        <Input
          placeholder={t('workflow_designer_name_placeholder')}
          value={workflowName}
          onChange={(e) => setWorkflowName(e.target.value)}
          style={{ width: 220 }}
        />
        <Input
          placeholder={t('workflow_designer_desc_placeholder')}
          value={workflowDesc}
          onChange={(e) => setWorkflowDesc(e.target.value)}
          style={{ width: 280 }}
        />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder={t('workflow_designer_bind_agent_placeholder')}
          value={workflowAgentId}
          onChange={(v) => setWorkflowAgentId(v)}
          style={{ width: 220 }}
          options={availableAgents.map((a) => ({ label: a.name, value: a.id }))}
          title={t('workflow_designer_bind_agent_help')}
        />
        <div style={{ flex: 1 }} />
        {executionStatus && (
          <Space size={4}>
            {running
              ? <LoadingOutlined style={{ color: '#1677ff' }} />
              : executionStatus === 'completed'
                ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
                : <StopOutlined style={{ color: '#ff4d4f' }} />}
            <Badge
              status={running ? 'processing' : executionStatus === 'completed' ? 'success' : executionStatus === 'failed' ? 'error' : 'default'}
              text={<span style={{ fontSize: 12 }}>{executionStatus}</span>}
            />
          </Space>
        )}
        {running && executionId ? (
          <Button icon={<StopOutlined />} danger onClick={handleCancel}>
            {t('workflow_designer_cancel_run')}
          </Button>
        ) : (
          <Button icon={<PlayCircleOutlined />} loading={running && !executionId} onClick={handleRun} disabled={!savedWorkflowId.current}>
            {t('workflow_designer_run')}
          </Button>
        )}
        <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
          {t('workflow_designer_save')}
        </Button>
      </div>

      {/* ── Canvas ──────────────────────────────────────────────────────────── */}
      <div
        ref={reactFlowWrapper}
        style={{ flex: 1, border: '1px solid #e8e8e8', borderRadius: 8, overflow: 'hidden' }}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          fitView
          snapToGrid
          snapGrid={[15, 15]}
          deleteKeyCode="Delete"
        >
          <Controls />
          <MiniMap
            nodeColor={(n) => NODE_COLORS[n.type || 'task'] || '#aaa'}
            style={{ background: '#fafafa', border: '1px solid #e8e8e8' }}
          />
          <Background variant={BackgroundVariant.Dots} gap={12} size={1} color="#d9d9d9" />

          {/* ── Node palette ─────────────────────────────────────────────── */}
          <Panel position="top-left">
            <Card
              size="small"
              title={
                <span style={{ fontSize: 12, fontWeight: 600 }}>
                  {t('workflow_designer_palette_title')}
                </span>
              }
              style={{ boxShadow: '0 2px 12px rgba(0,0,0,0.12)', width: 148 }}
              styles={{ body: { padding: '6px 8px' } }}
            >
              <div style={{ fontSize: 10, color: '#bfbfbf', marginBottom: 6, textAlign: 'center' }}>
                {t('workflow_designer_palette_drag_hint')}
              </div>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                {PALETTE_ITEMS.map((item) => (
                  <div
                    key={item.type}
                    draggable
                    onDragStart={(e) => onDragStart(e, item.type)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '5px 8px',
                      borderRadius: 6,
                      border: `1px solid ${item.color}22`,
                      background: `${item.color}0d`,
                      cursor: 'grab',
                      userSelect: 'none',
                      transition: 'background 0.15s, box-shadow 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = `${item.color}22`
                      e.currentTarget.style.boxShadow = `0 2px 6px ${item.color}44`
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = `${item.color}0d`
                      e.currentTarget.style.boxShadow = 'none'
                    }}
                  >
                    <HolderOutlined style={{ color: '#bfbfbf', fontSize: 10, flexShrink: 0 }} />
                    <span style={{ color: item.color, fontSize: 12, flexShrink: 0 }}>{item.icon}</span>
                    <span style={{ fontSize: 12, color: '#333', flex: 1 }}>{t(item.labelKey)}</span>
                    <Tooltip title={t(item.labelKey)} mouseEnterDelay={0.5}>
                      <Button
                        size="small"
                        type="text"
                        icon={<PlusOutlined />}
                        onClick={() => addNode(item.type)}
                        style={{ color: item.color, padding: '0 2px', height: 20, width: 20, flexShrink: 0 }}
                      />
                    </Tooltip>
                  </div>
                ))}
              </Space>
            </Card>
          </Panel>
        </ReactFlow>
      </div>

      {/* ── Properties Drawer ───────────────────────────────────────────────── */}
      <Drawer
        title={
          <span>
            {t('workflow_designer_drawer_title')}:{' '}
            <Tag color={NODE_COLORS[selectedNode?.type || ''] || 'default'}>{selectedNode?.type}</Tag>
          </span>
        }
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setSelectedNode(null) }}
        width={400}
        extra={
          <Button danger icon={<DeleteOutlined />} size="small" onClick={handleDeleteNode}>
            {t('workflow_designer_delete')}
          </Button>
        }
      >
        <Form form={nodeForm} layout="vertical" onFinish={handleUpdateNode}>
          {renderFormFields()}
          <Divider style={{ margin: '12px 0' }} />
          <Form.Item>
            <Button type="primary" htmlType="submit" block>{t('workflow_designer_apply')}</Button>
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  )
}

// ─── Wrapper with ReactFlowProvider (required for useReactFlow hook) ──────────

const WorkflowDesigner: React.FC = () => (
  <ReactFlowProvider>
    <WorkflowDesignerInner />
  </ReactFlowProvider>
)

export default WorkflowDesigner
