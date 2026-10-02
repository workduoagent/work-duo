// 数字 ID 排序——缺陷：Array.prototype.sort 默认按字符串码点比较（ECMA-262 §23.1.4.6），
// 数字数组会得到 [1, 10, 2] 这类字典序结果。
export function sortIds(ids) {
  return [...ids].sort()
}
