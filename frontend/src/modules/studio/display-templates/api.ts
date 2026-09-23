import api from '../api'

export interface TemplateVersion {
  version: number
  is_published: boolean
  changelog?: string | null
  created_by?: string | null
  created_at?: string | null
  published_at?: string | null
  layout: string
  header_fields: FieldSpec[]
  item_kinds: ItemKind[]
  metrics?: Record<string, unknown>
  on_publish?: Record<string, unknown>
  targets: string[]
  default_visibility?: string | null
}

export interface FieldSpec { key: string; label?: string; type?: string }
export interface ItemKind { key: string; label?: string; fields?: (string | FieldSpec)[]; statusable?: boolean; claimable?: boolean }

export interface TemplateSummary {
  key: string
  name: string
  description?: string | null
  scope: string
  status: string
  current_version?: number | null
  source: string
  /** 种子模板只读：升级种子时不该和用户的改动冲突 */
  editable: boolean
  updated_at?: string | null
}

export interface TemplateDetail extends TemplateSummary {
  versions: TemplateVersion[]
}

export interface LayoutError { line: number; col: number; code: string; message: string }

export interface PreviewResult {
  errors: LayoutError[]
  sample: Record<string, unknown>
  /** 预览就是看板上那一段 HTML 本身，没有任何加工 */
  html: string
  /** 默认样式表。iframe 不继承外面的样式，要和 html 一起塞进去 */
  css?: string
  /** 模板声明了整页布局（列表 + 详情）还是只有详情 */
  has_page?: boolean
}

export interface References {
  agents: { id: string; name: string; version?: string | number | null }[]
  workflows: { id: string; name: string }[]
  artifacts: number
  total: number
}

const BASE = '/display-templates'

export const templateApi = {
  list: (params?: { scope?: string; status?: string; q?: string }) =>
    api.get<{ total: number; items: TemplateSummary[] }>(BASE, { params }),
  get: (key: string) => api.get<TemplateDetail>(`${BASE}/${key}`),
  create: (data: Record<string, unknown>) => api.post<TemplateDetail>(BASE, data),
  update: (key: string, data: Record<string, unknown>) => api.put<TemplateDetail>(`${BASE}/${key}`, data),
  publish: (key: string) => api.post<TemplateDetail>(`${BASE}/${key}/publish`, {}),
  rollback: (key: string, version: number) => api.post<TemplateDetail>(`${BASE}/${key}/rollback`, { version }),
  references: (key: string) => api.get<References>(`${BASE}/${key}/references`),
  remove: (key: string) => api.delete(`${BASE}/${key}`),
  /** 复制成可编辑的新模板 —— 种子模板不可改，这是「基于内置改一份」的唯一路径 */
  copy: (key: string, data: { key: string; name?: string; version?: number }) =>
    api.post<TemplateDetail>(`${BASE}/${key}/copy`, data),
  // 带上 key：后端据此找这份模板已有的真实产出来预览（有真实的就不用示例数据）
  /** 导出一份模板（跨环境搬运用）。返回的形状就是 import 要的形状。 */
  exportOne: (key: string) => api.get<Record<string, unknown>>(`/display-templates/${key}/export`),
  /** 导入：已存在同 key 就加一个草稿版本，不动线上那份 */
  importOne: (data: Record<string, unknown>) =>
    api.post<{ key: string; imported_version: number; created: boolean }>(
      '/display-templates/import', data),
  preview: (data: { key?: string; layout: string; header_fields: FieldSpec[]; item_kinds: ItemKind[]
                    tz_offset?: number }) =>
    api.post<PreviewResult>(`${BASE}/preview`, data),
}
