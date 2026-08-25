export const Commands = {
  greet: 'greet',
} as const

export type CommandName = (typeof Commands)[keyof typeof Commands]
