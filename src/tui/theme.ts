/** Nord theme — Deep Ocean + Aurora Blue palette for ink terminal rendering. */

export const Nord = {
  bg:       "#2E3440", // 深渊背景
  bgLight:  "#3B4252", // 面板背景
  border:   "#4C566A", // 分割线
  fg:       "#D8DEE9", // 极昼白 — 正文
  fgDim:    "#616E88", // 暗文

  cyan:     "#88C0D0", // 声呐主色 — 高亮/进度/链接
  blue:     "#81A1C1", // 极光蓝 — thinking/次要
  purple:   "#B48EAD", // 极光紫 — accent
  yellow:   "#EBCB8B", // 涟漪警告 — ripple block
  orange:   "#D08770", // 警告
  red:      "#BF616A", // 错误/删除
  green:    "#A3BE8C", // 成功/新增
  teal:     "#8FBCBB", // 信息
} as const

export type NordColor = keyof typeof Nord
