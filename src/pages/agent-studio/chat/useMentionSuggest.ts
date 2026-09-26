/**
 * @提及 / 斜杠指令浮层（台账 S1 自 chat.tsx 抽出，§2.2 规划项）。
 *
 * 职责：输入框触发词解析（@ / /）→ 候选过滤（技能 / MCP 服务 / 插件 / 指令）→
 * 键盘导航与选中回填（chip 化 / 指令立即执行）。
 * 纯 UI 逻辑，不持有业务 state：候选源与动作经参数注入。
 */
import { useCallback, useRef, useState } from 'react'
import type { SuggestItem, SuggestState } from './types'

/** 快捷指令定义（/ 触发）。动作由调用方注入（onNewChat 等），此处只描述。 */
export interface SlashCommandDef {
  key: string
  token: string
  label: string
  sub: string
}

/** 候选源（由主组件传入，含全量技能 / MCP / 插件）。 */
export interface MentionSources {
  skills: { id: string; name: string; identifier?: string; description?: string }[]
  mcps: { id: string; aliasName?: string; mcpName?: string }[]
  plugins: { id: string; name: string; identifier: string; description?: string }[]
  /** 斜杠指令（通常 4 条固定指令）。 */
  commands: SuggestItem[]
  /** 指令动作表：key → 执行（cmd:new / cmd:clear / cmd:reset / cmd:help）。 */
  runCommandAction: (key: string) => void
}

/**
 * @提及 / 指令浮层状态机。
 *
 * @param input / setInput  输入框受控值
 * @param textareaRef       光标定位用
 * @param setMentionTags    选中 @ 候选后写入 chip 列表
 * @param send              非浮层状态下 Enter 的默认行为（发送）
 */
export function useMentionSuggest(
  input: string,
  setInput: (v: string) => void,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  setMentionTags: React.Dispatch<React.SetStateAction<{ key: string; label: string; token: string }[]>>,
  sources: MentionSources,
  send: () => void,
) {
  const [suggest, setSuggest] = useState<SuggestState | null>(null)

  /** 解析输入框中位于光标前的激活触发词（@ 或 / 开头、且前导为行首或空白）。 */
  const computeTrigger = (
    text: string,
    caret: number,
  ): { mode: 'mention' | 'command'; start: number; end: number; query: string } | null => {
    let i = caret - 1
    while (i >= 0) {
      const ch = text[i]
      if (ch === ' ' || ch === '\n' || ch === '\t') break
      if (ch === '@' || ch === '/') {
        const prevCh = i > 0 ? text[i - 1] : ''
        const boundary = i === 0 || /\s/.test(prevCh)
        if (!boundary) break // 形如邮箱 foo@bar 不视为触发
        return { mode: ch === '@' ? 'mention' : 'command', start: i, end: caret, query: text.slice(i + 1, caret) }
      }
      i--
    }
    return null
  }

  /** 按模式 + 查询串过滤候选（@ 取技能 + MCP 服务 + 插件；/ 取快捷指令）。 */
  const getCandidates = useCallback(
    (mode: 'mention' | 'command', query: string): SuggestItem[] => {
      const q = query.trim().toLowerCase()
      if (mode === 'command') {
        return sources.commands.filter(
          (c) => !q || c.token.toLowerCase().includes(q) || c.label.toLowerCase().includes(q),
        )
      }
      const skills = sources.skills
        .filter(
          (s) =>
            !q ||
            s.name.toLowerCase().includes(q) ||
            (s.identifier || '').toLowerCase().includes(q) ||
            (s.description || '').toLowerCase().includes(q),
        )
        // token 用 skill.identifier（稳定、无空格），label 用 s.name 仅展示；硬化后不再依赖 name 做判断
        .map<SuggestItem>((s) => ({ key: `skill:${s.id}`, token: s.identifier || s.name, label: s.name, sub: s.description || '技能', group: '技能' }))
      const mcps = sources.mcps
        .filter((m) => !q || (m.aliasName || m.mcpName || '').toLowerCase().includes(q))
        .map<SuggestItem>((m) => {
          const name = m.aliasName || m.mcpName || m.id
          return { key: `mcp:${m.id}`, token: name, label: name, sub: 'MCP 服务', group: 'MCP 服务' }
        })
      // 插件候选：token 用 identifier（稳定无空格），label 用 name 仅展示
      const plugins = sources.plugins
        .filter(
          (p) =>
            !q ||
            p.name.toLowerCase().includes(q) ||
            p.identifier.toLowerCase().includes(q) ||
            (p.description || '').toLowerCase().includes(q),
        )
        .map<SuggestItem>((p) => ({
          key: `plugin:${p.id}`,
          token: p.identifier || p.name,
          label: p.name,
          sub: '插件',
          group: '插件',
        }))
      return [...skills, ...mcps, ...plugins]
    },
    [sources],
  )

  /** 依据当前文本与光标位置刷新浮层；命中候选则展开，否则收起。 */
  const syncSuggest = useCallback(
    (text: string, caret: number) => {
      const trig = computeTrigger(text, caret)
      if (!trig) {
        setSuggest(null)
        return
      }
      const items = getCandidates(trig.mode, trig.query)
      if (items.length === 0) {
        setSuggest(null)
        return
      }
      setSuggest((prev) => {
        const p = prev
        // 触发词签名未变（仅光标微调）时保留当前高亮，避免方向键被 keyup 重置
        const keepIndex = p && p.mode === trig.mode && p.query === trig.query && p.index < items.length ? p.index : 0
        return { ...trig, items, index: keepIndex }
      })
    },
    [getCandidates],
  )

  /** 选中 @提及 候选：把触发词从文本框剥离，改为生成一个可移除的 Tag（chip）。 */
  const applyMention = useCallback(
    (item: SuggestItem) => {
      if (!suggest) return
      // 从文本框删除「@query」片段（标签已独立承载，避免空格歧义）
      const next = input.slice(0, suggest.start) + input.slice(suggest.end)
      setInput(next)
      setMentionTags((prev) => {
        if (prev.some((t) => t.key === item.key)) return prev // 去重：同一技能/MCP 不重复添加
        // 写入 chip：label 展示人类名，token 携带 identifier（send 序列化与 regenerate 反解都按 token 匹配）
        return [...prev, { key: item.key, label: item.label, token: item.token }]
      })
      setSuggest(null)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (el) {
          el.focus()
          const caret = suggest.start
          el.setSelectionRange(caret, caret)
        }
      })
    },
    [suggest, input, setInput, setMentionTags, textareaRef],
  )

  /** 选中 / 指令：立即执行对应动作（动作表由调用方注入）。 */
  const runCommand = useCallback(
    (item: SuggestItem) => {
      setSuggest(null)
      setInput('')
      setMentionTags([])
      sources.runCommandAction(item.key)
    },
    [setInput, setMentionTags, sources],
  )

  /** 输入框内容变化：写回 state 并刷新浮层。 */
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value
      setInput(val)
      syncSuggest(val, e.target.selectionStart ?? val.length)
    },
    [setInput, syncSuggest],
  )

  /** 光标移动（点击 / 方向键）：重新判定触发词，离开触发词则收起浮层。 */
  const handleCaretMove = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const el = e.currentTarget
      syncSuggest(el.value, el.selectionStart ?? el.value.length)
    },
    [syncSuggest],
  )

  /** 键盘事件：浮层展开时方向键导航、Enter/Tab 选中、Esc 收起；否则保持原 Enter 发送逻辑。 */
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (suggest && suggest.items.length > 0) {
        const n = suggest.items.length
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSuggest((s) => (s ? { ...s, index: (s.index + 1) % n } : s))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSuggest((s) => (s ? { ...s, index: (s.index - 1 + n) % n } : s))
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const item = suggest.items[suggest.index]
          if (item) {
            if (suggest.mode === 'mention') applyMention(item)
            else runCommand(item)
          }
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setSuggest(null)
          return
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        send()
      }
    },
    [suggest, applyMention, runCommand, send],
  )

  /** 从正文反解已选 chip（regenerate 场景回填用）：给调用方保留命令式收口。 */
  const clearSuggest = useCallback(() => setSuggest(null), [])
  const suggestRef = useRef<SuggestState | null>(null)
  suggestRef.current = suggest

  return {
    suggest,
    setSuggest,
    clearSuggest,
    suggestRef,
    handleInputChange,
    handleCaretMove,
    handleInputKeyDown,
    applyMention,
    runCommand,
  }
}
