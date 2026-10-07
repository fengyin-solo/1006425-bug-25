import { ref } from 'vue'

import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'waste-to-energy-plant:entries'
const SCHEMA_VERSION = 2

// 每次落库自增：computed 读 listRows 时顺带订阅它，保存后预警数等派生值能自动刷新。
export const storageRevision = ref(0)

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 同一条监测记录的多次报送只入一份：监测编号相同的，保留采集时间最新的一条（再同则取较大 id）。
function dedupeCems(rows: EntryRow[]): EntryRow[] {
  const picked = new Map<string, EntryRow>()
  for (const row of rows) {
    const code = String(row['监测编号'] ?? '').trim()
    if (!code) {
      // 没有监测编号的不参与合并，原样保留并给个唯一槽位
      picked.set(`__no-code-${row.id}`, row)
      continue
    }
    const prev = picked.get(code)
    if (!prev) {
      picked.set(code, row)
      continue
    }
    const prevKey = `${String(prev['采集时间'] ?? '')}#${Number(prev.id)}`
    const rowKey = `${String(row['采集时间'] ?? '')}#${Number(row.id)}`
    if (rowKey > prevKey) {
      picked.set(code, row)
    }
  }
  return [...picked.values()].sort((a, b) => Number(a.id) - Number(b.id))
}

function migrate(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  // 历史版本的本地库：把存量监测记录按监测编号归并去重。
  if (data.cems) {
    data.cems = dedupeCems(data.cems)
  }
  return data
}

function readStorage(): Record<string, EntryRow[]> {
  // 种子里也可能带着同一监测编号的多次报送：首次播种同样过一遍归并，保证「只入一份」。
  const fallback = migrate(clone(SEED_ROWS))
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const versionKey = `${STORAGE_KEY}:version`
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    window.localStorage.setItem(versionKey, String(SCHEMA_VERSION))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    let merged: Record<string, EntryRow[]> = { ...fallback, ...parsed }
    const storedVersion = Number(window.localStorage.getItem(versionKey) ?? '1')
    if (storedVersion < SCHEMA_VERSION) {
      merged = migrate(merged)
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
      window.localStorage.setItem(versionKey, String(SCHEMA_VERSION))
    }
    return merged
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  void storageRevision.value
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  storageRevision.value += 1
}

export function resetRows(key: string): EntryRow[] {
  const rows = key === 'cems' ? dedupeCems(clone(SEED_ROWS[key] ?? [])) : clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

export { dedupeCems }
