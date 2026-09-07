import type { SVGProps } from 'react'

/**
 * Node.js 官方风格徽标（绿 #539E43 / #83CD29）。
 * 纯展示型品牌图标，不受主题色影响；尺寸由外层 .settings__nav-icon-img 控制。
 */
export function NodeLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 256 256" aria-hidden="true" {...props}>
      <path
        fill="#83CD29"
        d="M128 16 L223 74 L223 182 L128 240 L33 182 L33 74 Z"
      />
      <path
        fill="#539E43"
        d="M128 36 L203 80 L203 176 L128 220 L53 176 L53 80 Z"
      />
      <text
        x="128"
        y="138"
        textAnchor="middle"
        fontSize="74"
        fontWeight="700"
        fontFamily="'Segoe UI', Arial, sans-serif"
        fill="#ffffff"
        letterSpacing="-4"
      >
        node
      </text>
    </svg>
  )
}
