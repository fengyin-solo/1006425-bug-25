import { listRows, saveRows } from './local-store'
import {
  currentEffectiveFrom,
  currentVersion,
  evaluateByStandard,
  evaluateCurrent,
  isFactor,
  type CalcResult,
  type EmissionFactor,
} from './emission-standards'
import type { ActionResult, EntryRow } from './types'

export const CEMS_KEY = 'cems'

export const CEMS_STATUS = {
  waiting: '待采集',
  collected: '已采集',
  reviewed: '已审核',
  warning: '超标预警',
} as const

export type RecalcDiff = {
  id: number
  code: string
  factor: string
  factorName: string
  unit: string
  measured: number | null
  o2: number | null
  oldVersion: string
  newVersion: string
  oldLimit: number | null
  newLimit: number | null
  oldFactor42: number | null
  newFactor42: number | null
  oldConverted: number | null
  newConverted: number | null
  convertedDelta: number | null
  oldExceed: boolean
  newExceed: boolean
  flipped: 'none' | 'to-exceed' | 'to-pass'
  statusBefore: string
  statusAfter: string
  frozen: boolean
  skipped: boolean
  reason: string
}

export type RecalcReport = {
  version: string
  effectiveFrom: string
  ranAt: string
  scanned: number
  recalculated: number
  frozen: number
  skipped: number
  warningsBefore: number
  warningsAfter: number
  diffs: RecalcDiff[]
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

// 从一条记录取算法入参；实测值缺失视为尚未采集。
export function calcInputOf(row: EntryRow): { factor: string; measured: number | null; o2: number | null } {
  return {
    factor: String(row['监测因子'] ?? ''),
    measured: toNumber(row['实测值']),
    o2: toNumber(row['实测氧含量']),
  }
}

// 用同一套算法把判定结果写回记录字段；版本不同则取对应历史口径（用于已审核记录的冻结展示）。
function writeCalc(row: EntryRow, calc: CalcResult, recalcTime?: string): EntryRow {
  const next: EntryRow = { ...row }
  next['排放限值'] = calc.limit ?? ''
  next['折算系数'] = calc.factor42 ?? ''
  next['折算值'] = calc.converted ?? ''
  next['判定口径版本'] = calc.version
  if (recalcTime !== undefined) {
    next['重算时间'] = recalcTime
  }
  return next
}

export function findByCode(rows: EntryRow[], code: string): EntryRow | undefined {
  const target = code.trim()
  return rows.find((row) => String(row['监测编号'] ?? '').trim() === target)
}

// 新报送：同监测编号只入一份，后报的覆盖先报的；未审核记录按当前口径即时计算。
export function submitRecord(input: {
  code: string
  factor: EmissionFactor
  measured: number
  o2: number | null
  collectedAt: string
}): ActionResult & { row?: EntryRow } {
  const code = input.code.trim()
  if (!code) {
    return { ok: false, message: '监测编号不能为空' }
  }
  if (!isFactor(input.factor)) {
    return { ok: false, message: `未登记监测因子「${input.factor}」的排放限值口径` }
  }
  if (!Number.isFinite(input.measured)) {
    return { ok: false, message: '实测值必须是数字' }
  }
  const rows = listRows(CEMS_KEY)
  const calc = evaluateCurrent({ factor: input.factor, measured: input.measured, o2: input.o2 })
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  const existing = findByCode(rows, code)
  if (existing) {
    if (String(existing.status) === CEMS_STATUS.reviewed) {
      return { ok: false, message: `监测编号 ${code} 已审核封档，不接受重复报送` }
    }
    const index = rows.indexOf(existing)
    let merged = writeCalc(
      {
        ...existing,
        '监测因子': input.factor,
        '实测值': input.measured,
        '实测氧含量': input.o2 ?? '',
        '采集时间': input.collectedAt || now,
        '审核人员': '',
        '监测状态': calc.exceed ? '重复报送已按新口径重算，判超标' : '重复报送已按新口径重算，判达标',
      },
      calc,
      '',
    )
    merged = {
      ...merged,
      status: calc.exceed ? CEMS_STATUS.warning : CEMS_STATUS.collected,
      pending: !calc.exceed,
      abnormal: calc.exceed,
    }
    const next = [...rows]
    next[index] = merged
    saveRows(CEMS_KEY, next)
    return { ok: true, message: `监测编号 ${code} 已存在，本次报送覆盖旧数据并按当前口径重新判定`, row: merged }
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  let created = writeCalc(
    {
      id: nextId,
      status: CEMS_STATUS.collected,
      pending: true,
      abnormal: false,
      '监测编号': code,
      '监测因子': input.factor,
      '实测值': input.measured,
      '实测氧含量': input.o2 ?? '',
      '采集时间': input.collectedAt || now,
      '审核人员': '',
      '监测状态': '按当前限值口径采集',
      '判定口径版本': '',
      '重算时间': '',
    },
    calc,
  )
  if (calc.exceed) {
    created = { ...created, status: CEMS_STATUS.warning, pending: false, abnormal: true }
  }
  saveRows(CEMS_KEY, [...rows, created])
  return { ok: true, message: `监测编号 ${code} 已按当前口径（${calc.version}）采集入数`, row: created }
}

// 待采集记录补数：提交采集动作走到已采集，限值与折算值同口径算出来。
export function attachMeasurement(
  id: number,
  measured: number,
  o2: number | null,
): ActionResult & { row?: EntryRow } {
  const rows = listRows(CEMS_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的排放监测记录` }
  }
  const current = rows[index]
  if (String(current.status) !== CEMS_STATUS.waiting) {
    return { ok: false, message: '只有待采集记录可以补报实测值' }
  }
  if (!isFactor(String(current['监测因子']))) {
    return { ok: false, message: '监测因子未登记排放限值口径，无法判定' }
  }
  const calc = evaluateCurrent({
    factor: String(current['监测因子']),
    measured,
    o2,
  })
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  let updated = writeCalc(
    {
      ...current,
      '实测值': measured,
      '实测氧含量': o2 ?? '',
      '采集时间': String(current['采集时间'] ?? '') || now,
      '监测状态': calc.exceed ? '采集即超标' : '按当前限值口径采集',
    },
    calc,
    '',
  )
  updated = { ...updated, status: CEMS_STATUS.collected, pending: true, abnormal: false }
  const next = [...rows]
  next[index] = updated
  saveRows(CEMS_KEY, next)
  return { ok: true, message: `已按当前口径（${calc.version}）折算并判定`, row: updated }
}

// 审核封档：把判定时所用口径版本固化在记录上，之后任何重算都不再回头改写。
export function freezeReviewed(id: number, reviewer: string): ActionResult & { row?: EntryRow } {
  const rows = listRows(CEMS_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的排放监测记录` }
  }
  const current = rows[index]
  if (String(current.status) !== CEMS_STATUS.collected) {
    return { ok: false, message: '只有已采集记录可以确认审核' }
  }
  const frozen: EntryRow = {
    ...current,
    status: CEMS_STATUS.reviewed,
    pending: false,
    abnormal: false,
    '审核人员': reviewer.trim() || '值班管理员',
    '监测状态': '按审核时口径封档保留',
  }
  const next = [...rows]
  next[index] = frozen
  saveRows(CEMS_KEY, next)
  return { ok: true, message: `监测记录已审核，按 ${frozen['判定口径版本']} 口径封档，不再参与重算`, row: frozen }
}

function diffOf(row: EntryRow, newCalc: CalcResult, ranAt: string): RecalcDiff {
  const oldVersion = String(row['判定口径版本'] ?? '') || '旧版未标注'
  const oldCalc = evaluateByStandard(calcInputOf(row), oldVersion)
  const oldExceed = String(row.status) === CEMS_STATUS.warning || oldCalc.exceed
  const newExceed = newCalc.exceed
  const oldConverted = toNumber(row['折算值']) ?? oldCalc.converted
  const flipped: RecalcDiff['flipped'] =
    !oldExceed && newExceed ? 'to-exceed' : oldExceed && !newExceed ? 'to-pass' : 'none'
  return {
    id: Number(row.id),
    code: String(row['监测编号'] ?? ''),
    factor: String(row['监测因子'] ?? ''),
    factorName: newCalc.factorName,
    unit: newCalc.unit,
    measured: newCalc.measured,
    o2: newCalc.o2,
    oldVersion,
    newVersion: newCalc.version,
    oldLimit: toNumber(row['排放限值']) ?? oldCalc.limit,
    newLimit: newCalc.limit,
    oldFactor42: toNumber(row['折算系数']) ?? oldCalc.factor42,
    newFactor42: newCalc.factor42,
    oldConverted,
    newConverted: newCalc.converted,
    convertedDelta:
      oldConverted !== null && newCalc.converted !== null ? round4(newCalc.converted - oldConverted) : null,
    oldExceed,
    newExceed,
    flipped,
    statusBefore: String(row.status),
    statusAfter: String(row.status),
    frozen: false,
    skipped: false,
    reason: '',
  }
}

// 判定标准调整后，对已经采集、尚未审核（含已发预警）的存量记录按新算法重算一遍。
// 已审核记录照当时算法保留，不回头改写；待采集记录没有实测值，跳过。
export function recalcCollected(): RecalcReport {
  const rows = listRows(CEMS_KEY)
  const ranAt = new Date().toLocaleString('zh-CN', { hour12: false })
  const next: EntryRow[] = []
  const diffs: RecalcDiff[] = []
  let frozenCount = 0
  let skippedCount = 0
  let recalculatedCount = 0
  const warningsBefore = rows.filter((row) => String(row.status) === CEMS_STATUS.warning).length

  for (const row of rows) {
    const status = String(row.status)
    if (status === CEMS_STATUS.reviewed) {
      frozenCount += 1
      diffs.push({
        id: Number(row.id),
        code: String(row['监测编号'] ?? ''),
        factor: String(row['监测因子'] ?? ''),
        factorName: evaluateByStandard(calcInputOf(row), String(row['判定口径版本'])).factorName,
        unit: evaluateByStandard(calcInputOf(row), String(row['判定口径版本'])).unit,
        measured: toNumber(row['实测值']),
        o2: toNumber(row['实测氧含量']),
        oldVersion: String(row['判定口径版本'] ?? ''),
        newVersion: currentVersion(),
        oldLimit: toNumber(row['排放限值']),
        newLimit: evaluateCurrent(calcInputOf(row)).limit,
        oldFactor42: toNumber(row['折算系数']),
        newFactor42: evaluateCurrent(calcInputOf(row)).factor42,
        oldConverted: toNumber(row['折算值']),
        newConverted: evaluateCurrent(calcInputOf(row)).converted,
        convertedDelta: null,
        oldExceed: false,
        newExceed: evaluateCurrent(calcInputOf(row)).exceed,
        flipped: 'none',
        statusBefore: status,
        statusAfter: status,
        frozen: true,
        skipped: false,
        reason: '已审核历史记录按当时算法保留，不回改',
      })
      next.push(row)
      continue
    }
    if (status === CEMS_STATUS.waiting || toNumber(row['实测值']) === null) {
      skippedCount += 1
      diffs.push({
        id: Number(row.id),
        code: String(row['监测编号'] ?? ''),
        factor: String(row['监测因子'] ?? ''),
        factorName: String(row['监测因子'] ?? ''),
        unit: '',
        measured: toNumber(row['实测值']),
        o2: toNumber(row['实测氧含量']),
        oldVersion: String(row['判定口径版本'] ?? ''),
        newVersion: currentVersion(),
        oldLimit: toNumber(row['排放限值']),
        newLimit: null,
        oldFactor42: toNumber(row['折算系数']),
        newFactor42: null,
        oldConverted: toNumber(row['折算值']),
        newConverted: null,
        convertedDelta: null,
        oldExceed: false,
        newExceed: false,
        flipped: 'none',
        statusBefore: status,
        statusAfter: status,
        frozen: false,
        skipped: true,
        reason: '尚未采集实测值，等数据到齐再算',
      })
      next.push(row)
      continue
    }

    const calc = evaluateCurrent(calcInputOf(row))
    const diff = diffOf(row, calc, ranAt)
    let updated = writeCalc(
      {
        ...row,
        '监测状态':
          diff.flipped === 'to-exceed'
            ? '重算后新限值下超标'
            : diff.flipped === 'to-pass'
              ? '重算后新限值下达标'
              : calc.exceed
                ? '重算后仍超标'
                : '重算后仍达标',
      },
      calc,
      ranAt,
    )
    if (calc.exceed) {
      updated = { ...updated, status: CEMS_STATUS.warning, pending: false, abnormal: true }
    } else {
      updated = { ...updated, status: CEMS_STATUS.collected, pending: true, abnormal: false }
    }
    diff.statusAfter = String(updated.status)
    diffs.push(diff)
    recalculatedCount += 1
    next.push(updated)
  }

  saveRows(CEMS_KEY, next)
  const warningsAfter = next.filter((row) => String(row.status) === CEMS_STATUS.warning).length
  return {
    version: currentVersion(),
    effectiveFrom: currentEffectiveFrom(),
    ranAt,
    scanned: rows.length,
    recalculated: recalculatedCount,
    frozen: frozenCount,
    skipped: skippedCount,
    warningsBefore,
    warningsAfter,
    diffs,
  }
}

// 已采集记录人工标记超标：只允许从已采集发起，且必须与当前口径的算法判定一致，否则拒绝（防止越级/误报）。
export function markExceed(id: number): ActionResult & { row?: EntryRow } {
  const rows = listRows(CEMS_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的排放监测记录` }
  }
  const current = rows[index]
  const status = String(current.status)
  if (status !== CEMS_STATUS.collected) {
    return { ok: false, message: `审核状态不允许越级：标记超标只能从「${CEMS_STATUS.collected}」发起，当前为「${status}」` }
  }
  const calc = evaluateCurrent(calcInputOf(current))
  if (calc.converted === null) {
    return { ok: false, message: '实测值缺失，无法按当前口径判定' }
  }
  if (!calc.exceed) {
    return { ok: false, message: `当前口径（${calc.version}）折算值 ${calc.converted} 未超过限值 ${calc.limit}，不能标记超标` }
  }
  const updated = writeCalc(
    {
      ...current,
      status: CEMS_STATUS.warning,
      pending: false,
      abnormal: true,
      '监测状态': '按当前限值口径判定超标',
    },
    calc,
    String(current['重算时间'] ?? ''),
  )
  const next = [...rows]
  next[index] = updated
  saveRows(CEMS_KEY, next)
  return { ok: true, message: `监测编号 ${updated['监测编号']} 已标记超标并进入环保监控预警清单`, row: updated }
}

// 预警清单的唯一取数口：在线排放监测列表、环保监控预警清单、运营概览都从这里读，数字天然一致。
export function listWarningRows(): EntryRow[] {
  return listRows(CEMS_KEY)
    .filter((row) => String(row.status) === CEMS_STATUS.warning)
    .sort((a, b) => String(b['采集时间'] ?? '').localeCompare(String(a['采集时间'] ?? '')))
}

export function countWarnings(): number {
  return listWarningRows().length
}
