const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

export function formatDateTime(input: Date | string | number): string {
  const d = toDate(input)
  return d ? dateFormatter.format(d) : '-'
}

export function formatRelativeTime(input: Date | string | number): string {
  const d = toDate(input)
  if (!d) return '-'
  const diff = Date.now() - d.getTime()
  const sec = Math.round(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day} 天前`
  return formatDateTime(input)
}

export function truncate(text: string, max = 50): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

export function formatBytes(bytes: number): string {
  if (bytes < 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function toDate(input: Date | string | number): Date | null {
  const d = input instanceof Date ? input : new Date(input)
  return Number.isNaN(d.getTime()) ? null : d
}
