export type CardType =
  | 'task'
  | 'task_list'
  | 'tool_execution'
  | 'approval'
  | 'code'
  | 'table'
  | 'form'
  | 'chart'
  | 'file'
  | 'workflow'
  | 'metrics'
  | 'memory'
  | 'article'
  | 'image_gallery'
  | 'video_result'
  | 'music_result'
  | 'voice_result'
  | 'program_result'

export interface CardAction {
  key: string
  label: string
  type: 'primary' | 'default' | 'danger'
  confirm?: string
  params?: Record<string, any>
}

export interface CardMessage {
  card_type: CardType
  card_id: string
  data: Record<string, any>
  actions?: CardAction[]
  status?: 'loading' | 'ready' | 'error'
}

export interface MessageAttachment {
  file_id:      string
  filename:     string
  content_type: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  cards?: CardMessage[]
  tool_calls?: ToolCall[]
  attachments?: MessageAttachment[]
  token_count?: number | null
  timestamp: string
  created_at?: string
  action?: {
    card_id: string
    action_key: string
    params?: Record<string, any>
  }
}

export interface ToolCall {
  tool: string
  parameters: Record<string, any>
  result?: any
  success?: boolean
  duration_ms?: number
}

export interface Conversation {
  id: string
  title: string
  agent_id?: string | null
  updated_at: string
}

export interface TaskCardData {
  task_id: string
  description: string
  status: string
  priority: number
  steps: TaskStep[]
  error_message?: string
  result?: any
}

export interface TaskStep {
  step_number: number
  action: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  parameters?: Record<string, any>
  output?: any
  duration_ms?: number
  reasoning?: string
}

export interface ToolExecutionCardData {
  tool_name: string
  status: 'running' | 'completed' | 'failed'
  duration_ms?: number
  parameters: Record<string, any>
  result?: any
  error?: string
}

export interface ApprovalCardData {
  approval_id: string
  operation_type: string
  command?: string
  description: string
  risk_level: 'low' | 'medium' | 'high' | 'critical'
  requester: string
  task_id?: string
  status: 'pending' | 'approved' | 'rejected'
  comment?: string
}

export interface CodeCardData {
  language: string
  code: string
  execution_result?: {
    output: string
    exit_code: number
    duration_ms: number
  }
}

export interface TableCardData {
  title?: string
  columns: { key: string; title: string; dataIndex: string }[]
  rows: Record<string, any>[]
  total?: number
  page_size?: number
}

export interface ChartCardData {
  title?: string
  type: 'bar' | 'line' | 'pie'
  labels: string[]
  datasets: { label: string; data: number[] }[]
}

export interface FormCardData {
  title: string
  fields: FormField[]
  task_id: string
}

export interface FormField {
  name: string
  label: string
  type: 'text' | 'select' | 'date' | 'radio' | 'checkbox' | 'number' | 'textarea'
  required?: boolean
  options?: { label: string; value: string }[]
  default_value?: any
  placeholder?: string
}

// ── New content-generation card types ────────────────────────────────────────

export interface ArticleCardData {
  topic: string
  article_type: string
  type_name: string
  language: string
  word_count: number
  read_minutes: number
  content: string       // Markdown text
  duration_s: number
}

export interface ImageItem {
  index: number
  url: string           // HTTP URL: /api/v1/workspace/images/{filename}
  filename: string
}

export interface ImageGalleryCardData {
  original_prompt: string
  final_prompt: string
  translated: boolean
  style: string
  size: string
  quality: string
  duration_s: number
  images: ImageItem[]
}

export interface VideoResultCardData {
  original_prompt: string
  final_prompt: string
  translated: boolean
  duration: number       // seconds
  aspect_ratio: string
  style: string
  provider: string
  video_url: string      // /api/v1/workspace/videos/{filename} (stable local URL)
  source_url?: string    // original CDN URL (may expire)
  filename: string
  generation_time_s: number
  progress: number       // 0-100, used during loading state
  message?: string
  error?: string
}

export interface MusicResultCardData {
  original_prompt: string
  final_prompt: string
  translated: boolean
  duration: number        // seconds requested
  style: string
  tempo: string
  provider: string
  audio_url: string       // /api/v1/workspace/audio/{filename} or source URL
  filename: string
  generation_time_s: number
  progress: number        // 0-100 during loading
  message?: string
  error?: string
}

export interface VoiceResultCardData {
  text: string           // the spoken text
  audio_url: string      // /api/v1/workspace/audio/{filename}
  filename: string
  voice: string          // alloy | echo | fable | onyx | nova | shimmer | mock
  provider: string       // openai/tts-1 | mock
  duration_s: number
  speed: number
  generation_time_s: number
  auto_play?: boolean
  error?: string
}

export interface ProgramFile {
  path: string
  language: string
  lines: number
  content: string
}

export interface ProgramExecResult {
  exit_code: number
  stdout: string
  stderr: string
  success: boolean
  skipped?: boolean
}

export interface ProgramResultCardData {
  requirement: string
  language: string
  project_type: string
  framework: string
  output_dir: string
  file_count: number
  total_lines: number
  duration_s: number
  files: ProgramFile[]
  exec_result?: ProgramExecResult | null
  lang_emoji: string
  run_cmd: string
}
