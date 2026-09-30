/**
 * 64×64 像素画布：以颜色字符串网格作画，输出水平合并后的 rect 列表。
 * 几何仍保持整数网格；水平合并显著减少 SVG 节点（小分队舞台多头像时关键）。
 */

export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
  fill: string
  /** 动画标记（空格分隔）：pa-fa/pa-fb=交替帧、pa-dot*=闪烁点 */
  cls?: string
}

export class PixelCanvas {
  readonly size: number
  private data: (string | null)[][]

  constructor(size = 64) {
    this.size = size
    this.data = Array.from({ length: size }, () => Array<string | null>(size).fill(null))
  }

  set(x: number, y: number, color: string | null): void {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= this.size || yi >= this.size) return
    this.data[yi][xi] = color
  }

  get(x: number, y: number): string | null {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return null
    return this.data[y][x]
  }

  rect(x: number, y: number, w: number, h: number, color: string): void {
    for (let dy = 0; dy < h; dy += 1) {
      for (let dx = 0; dx < w; dx += 1) this.set(x + dx, y + dy, color)
    }
  }

  /** 水平线 */
  hline(x: number, y: number, w: number, color: string): void {
    this.rect(x, y, w, 1, color)
  }

  /** 垂直线 */
  vline(x: number, y: number, h: number, color: string): void {
    this.rect(x, y, 1, h, color)
  }

  /** 实心圆（像素圆） */
  circle(cx: number, cy: number, r: number, color: string): void {
    const r2 = r * r
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y += 1) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x += 1) {
        const dx = x - cx
        const dy = y - cy
        if (dx * dx + dy * dy <= r2 + 0.15) this.set(x, y, color)
      }
    }
  }

  /** 椭圆（头、瞳孔用） */
  ellipse(cx: number, cy: number, rx: number, ry: number, color: string): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
        const dx = (x - cx) / rx
        const dy = (y - cy) / ry
        if (dx * dx + dy * dy <= 1.08) this.set(x, y, color)
      }
    }
  }

  /**
   * 外描边：在非空像素的空邻域画 outline 色（向外扩 1px）。
   * 只描「外轮廓」，内部镂空因被填充连续体包住一般不会被描。
   */
  outline(color: string): void {
    const marks: Array<[number, number]> = []
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (this.data[y][x] !== null) continue
        const near =
          this.get(x + 1, y) !== null ||
          this.get(x - 1, y) !== null ||
          this.get(x, y + 1) !== null ||
          this.get(x, y - 1) !== null
        if (near) marks.push([x, y])
      }
    }
    for (const [x, y] of marks) this.data[y][x] = color
  }

  /** 拷贝一份网格（供局部遮罩/合成） */
  cloneData(): (string | null)[][] {
    return this.data.map((row) => row.slice())
  }

  /**
   * 导出 rect：按行水平合并同色且同动画标记的相邻像素。
   * 动画标记由调用方通过 `clsAt` 回调查注（画布本身不存 cls）。
   */
  toRects(clsAt?: (x: number, y: number, color: string) => string | undefined): PixelRect[] {
    const out: PixelRect[] = []
    for (let y = 0; y < this.size; y += 1) {
      let x = 0
      while (x < this.size) {
        const fill = this.data[y][x]
        if (fill == null) {
          x += 1
          continue
        }
        const cls = clsAt?.(x, y, fill)
        let w = 1
        while (x + w < this.size && this.data[y][x + w] === fill) {
          const c2 = clsAt?.(x + w, y, fill)
          if (c2 !== cls) break
          w += 1
        }
        out.push({ x, y, w, h: 1, fill, cls })
        x += w
      }
    }
    return out
  }
}
