// 排放判定口径：全厂只有这一份。
// 在线排放监测（cems）的限值与折算系数、环保指标监控（emission）的预警清单、
// 运营概览的超标统计，都从这里的标准版本表取数；调整限值只需要改这张表。
//
// 算法约定（同一套算法，新采集与重算都走它）：
//   折算值 = 实测值 × 折算系数（保留两位小数）
//   折算值 > 排放限值 即判定超标
// 折算系数按监测因子给定的简化口径，代替按含氧量逐点换算的现场算法。

export type EmissionRule = {
  factor: string // 监测因子
  limit: number // 排放限值（mg/m³）
  coefficient: number // 折算系数
  unit: string
}

export type EmissionStandard = {
  version: string // 标准版本号，落库到记录上，用于追溯"按哪版算法算的"
  name: string
  effectiveFrom: string // 启用日期，启用日期最新的版本为当前口径
  rules: EmissionRule[]
}

// 标准版本表：旧版本留在表里，审核过的历史记录按当时版本保留、不回头改写。
export const EMISSION_STANDARDS: EmissionStandard[] = [
  {
    version: 'CEMS-2020',
    name: '生活垃圾焚烧污染控制限值（2020 版）',
    effectiveFrom: '2020-01-01',
    rules: [
      { factor: '颗粒物', limit: 30, coefficient: 1.0, unit: 'mg/m³' },
      { factor: '二氧化硫', limit: 100, coefficient: 1.0, unit: 'mg/m³' },
      { factor: '氮氧化物', limit: 300, coefficient: 1.0, unit: 'mg/m³' },
      { factor: '氯化氢', limit: 60, coefficient: 1.0, unit: 'mg/m³' },
      { factor: '一氧化碳', limit: 100, coefficient: 1.0, unit: 'mg/m³' },
    ],
  },
  {
    version: 'CEMS-2026',
    name: '生活垃圾焚烧污染控制限值（2026 调整版）',
    effectiveFrom: '2026-10-01',
    rules: [
      { factor: '颗粒物', limit: 20, coefficient: 1.1, unit: 'mg/m³' },
      { factor: '二氧化硫', limit: 80, coefficient: 1.1, unit: 'mg/m³' },
      { factor: '氮氧化物', limit: 250, coefficient: 1.1, unit: 'mg/m³' },
      { factor: '氯化氢', limit: 50, coefficient: 1.1, unit: 'mg/m³' },
      { factor: '一氧化碳', limit: 80, coefficient: 1.1, unit: 'mg/m³' },
    ],
  },
]

export function currentStandard(): EmissionStandard {
  return [...EMISSION_STANDARDS].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[
    EMISSION_STANDARDS.length - 1
  ]
}

export function findRule(factor: string, standard: EmissionStandard = currentStandard()): EmissionRule | undefined {
  return standard.rules.find((rule) => rule.factor === factor.trim())
}

export type JudgeResult = {
  limit: number
  coefficient: number
  converted: number
  exceeded: boolean
}

// 唯一判定入口：给监测因子和实测值，返回限值、折算系数、折算值与超标结论。
// 因子未登记在标准表或实测值不是数值时返回 null，调用方按"跳过"处理。
export function judgeMeasured(
  factor: string,
  measured: number,
  standard: EmissionStandard = currentStandard(),
): JudgeResult | null {
  const rule = findRule(factor, standard)
  if (!rule || !Number.isFinite(measured)) {
    return null
  }
  const converted = round2(measured * rule.coefficient)
  return {
    limit: rule.limit,
    coefficient: rule.coefficient,
    converted,
    exceeded: converted > rule.limit,
  }
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// 重算前后差值的统一写法：正数带 +，便于列表里一眼看出方向。
export function formatDelta(delta: number): string {
  const rounded = round2(delta)
  return rounded > 0 ? `+${rounded}` : `${rounded}`
}
