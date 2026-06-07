/**
 * Studio module manifest.
 *
 * Scope: AI application construction only.
 * - Agents, Workflows, Tools, MCP, Knowledge, Memory, Skills, Plugins, Connectors, Docs
 *
 * Does NOT own: runtime monitoring, policy governance, approvals, tenant/user admin.
 */

export const MODULE_ID = 'studio' as const

export const studioNavPaths = [
  '/agents',
  '/workflows',
  '/tools',
  '/mcp',
  '/knowledge',
  '/agent-knowledge',
  '/memory',
  '/skills',
  '/plugins',
  '/connectors',
  '/docs',
] as const
