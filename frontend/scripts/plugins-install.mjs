// 发布：项目根 plugins/* → ~/.onlyoffice/plugins/（env OO_PLUGINS_DIR 可覆盖）
import { cpSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const src = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'plugins')
const dst = process.env.OO_PLUGINS_DIR || join(os.homedir(), '.onlyoffice', 'plugins')

const names = readdirSync(src).filter((n) => !n.startsWith('.'))
mkdirSync(dst, { recursive: true })
for (const n of names) {
  cpSync(join(src, n), join(dst, n), { recursive: true, force: true })
  console.log('[plugins:install]', n, '->', dst)
}
console.log(`[plugins:install] 完成，共 ${names.length} 个 -> ${dst}`)
