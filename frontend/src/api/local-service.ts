import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { currentStandard, formatDelta, judgeMeasured } from '@/data/emission-standard'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  RecalcChange,
  RecalcResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚', '标记超标']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 审核状态不允许越级：登记了起始状态的动作，只能从列出的状态流转。
  const sources = meta.actionSources?.[action]
  if (sources && !sources.includes(current)) {
    return {
      ok: false,
      message: `${meta.entity}审核状态不允许越级：「${action}」只能从「${sources.join('」「')}」流转，当前状态「${current}」`,
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  // 排放监测记录一旦进入超标预警，同步一份到环保监控的预警清单（按监测编号对住，只入一份）。
  if (key === 'cems' && target === '超标预警') {
    syncEmissionWarnings()
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

// 同一监测编号多次报送只入一份：保留最新报送（采集时间靠后，相同再比 id 大）。
function dedupeByMonitorNo(rows: EntryRow[]): { rows: EntryRow[]; merged: number } {
  const latest = new Map<string, EntryRow>()
  for (const row of rows) {
    const no = String(row['监测编号'] ?? '').trim()
    if (!no) {
      continue
    }
    const kept = latest.get(no)
    if (!kept) {
      latest.set(no, row)
      continue
    }
    const keptTime = String(kept['采集时间'] ?? '')
    const rowTime = String(row['采集时间'] ?? '')
    if (rowTime > keptTime || (rowTime === keptTime && Number(row.id) > Number(kept.id))) {
      latest.set(no, row)
    }
  }
  const deduped = rows.filter((row) => {
    const no = String(row['监测编号'] ?? '').trim()
    return !no || latest.get(no) === row
  })
  return { rows: deduped, merged: rows.length - deduped.length }
}

// 判定标准调整之后，把已采集未审核的记录按当前标准重算一遍：
// 限值与折算系数都从 emission-standard.ts 的同一张表里取，重算前后差值留在「重算差值」列；
// 已审核的历史记录仍照当时的算法保留，不回头改写。重算结果落库并同步环保监控预警清单。
export function recalculateCemsEntries(): RecalcResult {
  const standard = currentStandard()
  const { rows: deduped, merged } = dedupeByMonitorNo(listRows('cems'))
  const changes: RecalcChange[] = []
  const details: string[] = []
  let warned = 0
  let skipped = 0
  const next = deduped.map((row) => {
    if (String(row.status) !== '已采集') {
      return row
    }
    if (String(row['适用标准'] ?? '') === standard.version) {
      return row // 已是当前口径，幂等跳过，重复点重算不会改写差值
    }
    const measured = Number(row['实测值'])
    const judge = judgeMeasured(String(row['监测因子'] ?? ''), measured, standard)
    if (!judge) {
      skipped += 1
      return row
    }
    const beforeConverted = String(row['折算值'] ?? '')
    const beforeLimit = String(row['排放限值'] ?? '')
    const oldConverted = Number(beforeConverted)
    const delta = beforeConverted !== '' && Number.isFinite(oldConverted)
      ? formatDelta(judge.converted - oldConverted)
      : ''
    const diffText = `${beforeConverted || '—'}→${judge.converted}${delta ? `(${delta})` : ''}`
    if (judge.exceeded) {
      warned += 1
    }
    changes.push({
      id: Number(row.id),
      monitorNo: String(row['监测编号'] ?? ''),
      factor: String(row['监测因子'] ?? ''),
      beforeLimit,
      afterLimit: judge.limit,
      beforeConverted,
      afterConverted: judge.converted,
      delta,
      exceeded: judge.exceeded,
    })
    details.push(
      `${row['监测编号']} ${row['监测因子']}：折算值 ${diffText}，排放限值 ${beforeLimit || '—'}→${judge.limit}，` +
        (judge.exceeded ? '判定超标，转入超标预警' : '未超标，保持已采集'),
    )
    return {
      ...row,
      折算系数: judge.coefficient,
      折算值: judge.converted,
      排放限值: judge.limit,
      适用标准: standard.version,
      重算差值: diffText,
      status: judge.exceeded ? '超标预警' : row.status,
      pending: judge.exceeded ? false : row.pending,
      abnormal: judge.exceeded ? true : row.abnormal,
      监测状态: judge.exceeded ? '超标预警' : row['监测状态'],
    }
  })
  saveRows('cems', next)
  const sync = syncEmissionWarnings()
  const message =
    changes.length === 0 && merged === 0
      ? `没有需要重算的记录：已采集记录均已按当前标准（${standard.version}）判定`
      : `重算完成（适用标准 ${standard.version}）：合并重复报送 ${merged} 条，重算 ${changes.length} 条，` +
        `其中 ${warned} 条转入超标预警；环保监控预警清单新增 ${sync.created} 条、更新 ${sync.updated} 条` +
        (skipped > 0 ? `；${skipped} 条因子未登记或实测值缺失，已跳过` : '')
  return {
    ok: true,
    message,
    standard: standard.version,
    merged,
    recalculated: changes.length,
    warned,
    skipped,
    syncedCreated: sync.created,
    syncedUpdated: sync.updated,
    changes,
    details,
  }
}

// 把 cems 里处于超标预警的记录同步成环保监控（emission）的未达标预警。
// 以监测编号对住监控编号：同一记录多次报送、多次同步都只入一份，已存在的更新而不是新增。
export function syncEmissionWarnings(): { created: number; updated: number } {
  const warnings = listRows('cems').filter((row) => String(row.status) === '超标预警')
  const rows = listRows('emission')
  const next = [...rows]
  const indexByNo = new Map<string, number>()
  next.forEach((row, index) => {
    const no = String(row['监控编号'] ?? '').trim()
    if (no) {
      indexByNo.set(no, index)
    }
  })
  let maxId = next.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  let created = 0
  let updated = 0
  for (const warning of warnings) {
    const no = String(warning['监测编号'] ?? '').trim()
    if (!no) {
      continue
    }
    const payload: EntryRow = {
      id: 0,
      status: '未达标',
      pending: false,
      abnormal: true,
      监控编号: no,
      监控指标: warning['监测因子'] ?? '',
      限值要求: warning['排放限值'] ?? '',
      实测值: warning['折算值'] ?? '',
      达标判定: '超标',
      监控日期: warning['采集时间'] ?? '',
      监控人员: '系统同步',
      监控状态: '未达标',
    }
    const existingIndex = indexByNo.get(no)
    if (existingIndex === undefined) {
      maxId += 1
      payload.id = maxId
      indexByNo.set(no, next.length)
      next.push(payload)
      created += 1
    } else {
      payload.id = Number(next[existingIndex].id)
      if (JSON.stringify(payload) !== JSON.stringify(next[existingIndex])) {
        next[existingIndex] = payload
        updated += 1
      }
    }
  }
  if (created > 0 || updated > 0) {
    saveRows('emission', next)
  }
  return { created, updated }
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
