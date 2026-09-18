/**
 * Tiny JSON-file persistence for the no-database mode: whole value read at start, whole value
 * written on every change. Fine for accounts and ranked totals on a single instance.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class JsonFile<T> {
  constructor(private readonly path: string) {}

  load(fallback: T): T {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as T
    } catch {
      return fallback // missing or unreadable: start empty
    }
  }

  save(value: T): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(value, null, 2))
  }
}
