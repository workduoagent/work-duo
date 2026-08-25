// SQLite table -> TypeScript row mappings.
// Keep these in sync with the Rust `sqlx` / migration definitions.

export interface KnowledgeBaseRow {
  id: string
  name: string
  description: string | null
  doc_count: number
  created_at: number
  updated_at: number
}

export interface ModelConfigRow {
  id: string
  provider: string
  name: string
  base_url: string | null
  api_key: string | null
  enabled: number // SQLite boolean (0 / 1)
  created_at: number
}

export interface AgentRow {
  id: string
  name: string
  role: string
  model_id: string | null
  system_prompt: string | null
  created_at: number
}

export interface SquadRow {
  id: string
  name: string
  description: string | null
  member_ids: string // JSON array stored as text
  created_at: number
}
