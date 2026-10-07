// 排放限值与折算系数的唯一口径来源。
// 采集入数、存量重算、超标预警三处都走这里的算法，避免各页各算各的。
//
// 判定规则（新旧两版一致，只是限值与折算参数不同）：
//   折算值 = 实测值 × (21 - 基准氧含量) / (21 - 实测氧含量)
//   折算值 > 排放限值 => 超标；汞及其化合物不参与氧含量折算，折算系数恒为 1。

export type EmissionFactor =
  | 'SO2'
  | 'NOx'
  | '颗粒物'
  | 'HCl'
  | 'Hg'

export type FactorStandard = {
  factor: EmissionFactor
  factorName: string
  unit: string
  /** 小时均值排放限值，单位与 unit 一致 */
  limit: number
  /** 基准氧含量（%）。汞等不参与折算的因子记为 0 */
  referenceO2: number
  version: string
  effectiveFrom: string
}

// 当前执行的口径：限值调整后只改这一张表，新采集与存量重算都按它取数。
const CURRENT_VERSION = 'GB18484-2026修订版'
const CURRENT_EFFECTIVE_FROM = '2026-07-01'

const CURRENT_STANDARDS: Record<EmissionFactor, Omit<FactorStandard, 'version' | 'effectiveFrom'>> = {
  SO2: { factor: 'SO2', factorName: '二氧化硫', unit: 'mg/m³', limit: 80, referenceO2: 11 },
  NOx: { factor: 'NOx', factorName: '氮氧化物', unit: 'mg/m³', limit: 250, referenceO2: 11 },
  颗粒物: { factor: '颗粒物', factorName: '颗粒物', unit: 'mg/m³', limit: 20, referenceO2: 11 },
  HCl: { factor: 'HCl', factorName: '氯化氢', unit: 'mg/m³', limit: 50, referenceO2: 11 },
  // 汞及其化合物按实测值直接判定，不做氧含量折算
  Hg: { factor: 'Hg', factorName: '汞及其化合物', unit: 'mg/m³', limit: 0.05, referenceO2: 0 },
}

// 限值调整前的旧口径：已审核历史记录按当时版本冻结时取这里做对照展示。
const HISTORIC_STANDARDS: Record<string, Record<EmissionFactor, Omit<FactorStandard, 'version' | 'effectiveFrom'>>> = {
  'GB18484-2014': {
    SO2: { factor: 'SO2', factorName: '二氧化硫', unit: 'mg/m³', limit: 100, referenceO2: 11 },
    NOx: { factor: 'NOx', factorName: '氮氧化物', unit: 'mg/m³', limit: 300, referenceO2: 11 },
    颗粒物: { factor: '颗粒物', factorName: '颗粒物', unit: 'mg/m³', limit: 30, referenceO2: 11 },
    HCl: { factor: 'HCl', factorName: '氯化氢', unit: 'mg/m³', limit: 60, referenceO2: 11 },
    Hg: { factor: 'Hg', factorName: '汞及其化合物', unit: 'mg/m³', limit: 0.05, referenceO2: 0 },
  },
}

export const FACTOR_OPTIONS: { value: EmissionFactor; label: string }[] = [
  { value: 'SO2', label: 'SO2（二氧化硫）' },
  { value: 'NOx', label: 'NOx（氮氧化物）' },
  { value: '颗粒物', label: '颗粒物' },
  { value: 'HCl', label: 'HCl（氯化氢）' },
  { value: 'Hg', label: 'Hg（汞及其化合物）' },
]

export function currentVersion(): string {
  return CURRENT_VERSION
}

export function currentEffectiveFrom(): string {
  return CURRENT_EFFECTIVE_FROM
}

export function isFactor(value: string): value is EmissionFactor {
  return Object.prototype.hasOwnProperty.call(CURRENT_STANDARDS, value)
}

export function standardOf(factor: string, version?: string): FactorStandard | null {
  if (!isFactor(factor)) {
    return null
  }
  const table =
    version && HISTORIC_STANDARDS[version]
      ? HISTORIC_STANDARDS[version]
      : CURRENT_STANDARDS
  const base = table[factor]
  return {
    ...base,
    version: version && HISTORIC_STANDARDS[version] ? version : CURRENT_VERSION,
    effectiveFrom: version && HISTORIC_STANDARDS[version] ? '2014-07-01' : CURRENT_EFFECTIVE_FROM,
  }
}

export type CalcInput = {
  factor: string
  measured: number | null
  o2?: number | null
}

export type CalcResult = {
  factor: string
  factorName: string
  unit: string
  measured: number | null
  o2: number | null
  limit: number | null
  converted: number | null
  factor42: number | null
  exceed: boolean
  verdict: string
  version: string
  effectiveFrom: string
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// 同一套算法：新采集、存量重算、历史冻结对照都调它，区别只在传入的标准版本。
export function evaluateByStandard(input: CalcInput, version?: string): CalcResult {
  const standard = standardOf(input.factor, version)
  if (!standard || input.measured === null || Number.isNaN(input.measured)) {
    const fallback = standard
    return {
      factor: input.factor,
      factorName: fallback?.factorName ?? input.factor,
      unit: fallback?.unit ?? '',
      measured: input.measured,
      o2: input.o2 ?? null,
      limit: fallback?.limit ?? null,
      converted: null,
      factor42: null,
      exceed: false,
      verdict: '待采集',
      version: fallback?.version ?? (version ?? CURRENT_VERSION),
      effectiveFrom: fallback?.effectiveFrom ?? CURRENT_EFFECTIVE_FROM,
    }
  }
  const factor42 =
    standard.referenceO2 > 0 && input.o2 !== null && input.o2 !== undefined
      ? (21 - standard.referenceO2) / (21 - input.o2)
      : 1
  const converted = round2(input.measured * factor42)
  const exceed = converted > standard.limit
  return {
    factor: standard.factor,
    factorName: standard.factorName,
    unit: standard.unit,
    measured: input.measured,
    o2: input.o2 ?? null,
    limit: standard.limit,
    converted,
    factor42: round2(factor42),
    exceed,
    verdict: exceed ? '超标' : '达标',
    version: standard.version,
    effectiveFrom: standard.effectiveFrom,
  }
}

// 当前口径下的判定，采集与重算默认走这里。
export function evaluateCurrent(input: CalcInput): CalcResult {
  return evaluateByStandard(input, CURRENT_VERSION)
}
