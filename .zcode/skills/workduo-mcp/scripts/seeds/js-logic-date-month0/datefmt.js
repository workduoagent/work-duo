// 本地日期解析——缺陷：new Date(y, m, d) 的 month 是 0 基（ECMA-262），
// 从 "YYYY-MM-DD" 拆出的月份直接传入会整体偏移一个月（09 月变 10 月）。
export function parseLocalDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m, d) // 缺陷：应为 m - 1
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function monthLabel(iso) {
  return MONTH_NAMES[parseLocalDate(iso).getMonth()]
}
