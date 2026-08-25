import { isTauri } from '@/core/config'

const STORE_FILE = 'work-duo.dat'
const memoryFallback = new Map<string, unknown>()

async function getStore() {
  if (!isTauri) return null
  // Dynamic import so the plugin is only pulled in inside a real Tauri runtime.
  const { load } = await import('@tauri-apps/plugin-store')
  return load(STORE_FILE)
}

export async function loadConfig<T>(key: string, fallback: T): Promise<T> {
  try {
    const store = await getStore()
    if (store) {
      const value = await store.get<T>(key)
      if (value !== null && value !== undefined) return value
    }
  } catch {
    /* fall through to in-memory / fallback */
  }
  const raw = memoryFallback.get(key)
  return raw !== undefined ? (raw as T) : fallback
}

export async function saveConfig<T>(key: string, value: T): Promise<void> {
  memoryFallback.set(key, value)
  try {
    const store = await getStore()
    if (store) {
      await store.set(key, value)
      await store.save()
    }
  } catch {
    /* best-effort persistence */
  }
}
