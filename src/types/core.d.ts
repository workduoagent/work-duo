// Core base types shared across the app.

export type ID = string

export type Maybe<T> = T | null

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type AsyncStatus = 'idle' | 'loading' | 'success' | 'error'

export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}
