/* 重型依赖兜底声明：仅在本体（@xyflow/react）尚未 install 时让 typecheck 通过。
 * 用户执行 `pnpm i @xyflow/react` 后，node_modules 中的真实类型会优先生效，本文件可保留（不冲突）。
 * 若安装后仍报重复声明，删除本文件即可。
 */
declare module '@xyflow/react' {
  import type { ComponentType, ReactNode } from 'react'

  export type Node<T = any> = {
    id: string
    type?: string
    position: { x: number; y: number }
    data: T
    [k: string]: any
  }
  export type Edge = {
    id: string
    source: string
    target: string
    [k: string]: any
  }
  export type Connection = {
    source: string | null
    target: string | null
    sourceHandle?: string | null
    targetHandle?: string | null
  }
  export type NodeChange = any
  export type EdgeChange = any
  export type NodeProps = any
  export type ReactFlowInstance = any

  export const ReactFlow: ComponentType<any>
  export const Background: ComponentType<any>
  export const Controls: ComponentType<any>
  export const MiniMap: ComponentType<any>
  export const Handle: ComponentType<any>
  export const Position: { Left: string; Right: string; Top: string; Bottom: string }
  export const ReactFlowProvider: ComponentType<any>
  export function useNodesState<T = any>(
    initial: T[],
  ): [T[], (v: T[] | ((p: T[]) => T[])) => void, (changes: any) => void]
  export function useEdgesState<T = any>(
    initial: T[],
  ): [T[], (v: T[] | ((p: T[]) => T[])) => void, (changes: any) => void]
  export function addEdge(edgeParams: any, edges: any[]): any[]
  export function applyNodeChanges(changes: any[], nodes: any[]): any[]
  export function applyEdgeChanges(changes: any[], edges: any[]): any[]
  export function useReactFlow(): ReactFlowInstance
}

// ReactFlow 基础样式表（未 install 时让 typecheck 通过，install 后由真实文件覆盖）。
declare module '@xyflow/react/dist/style.css'
