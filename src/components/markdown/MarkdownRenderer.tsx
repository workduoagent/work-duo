import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export interface MarkdownRendererProps {
  content: string
  className?: string
}

// Unified Markdown/AST renderer. Styling lives in `.md-body` (src/styles/root.css).
export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={`md-body ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}
