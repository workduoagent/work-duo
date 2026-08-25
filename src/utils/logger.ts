type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const PREFIX = '[work-duo]'

function build(level: LogLevel, message: string, rest: unknown[]) {
  return [`${PREFIX} ${level.toUpperCase()} ${message}`, ...rest]
}

export const logger = {
  debug: (message: string, ...rest: unknown[]) =>
    console.debug(...build('debug', message, rest)),
  info: (message: string, ...rest: unknown[]) =>
    console.info(...build('info', message, rest)),
  warn: (message: string, ...rest: unknown[]) =>
    console.warn(...build('warn', message, rest)),
  error: (message: string, ...rest: unknown[]) =>
    console.error(...build('error', message, rest)),
}
