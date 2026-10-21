// 必须作为 assistant.mjs 第一个 import：静态 import 的插件模块顶层读 env，
// 而 ESM 求值先于 assistant 顶层代码，.env 得在这里先加载
import { loadEnvFile } from './lib.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
loadEnvFile(path.join(here, '.env'))
loadEnvFile(path.join(here, '..', '..', '.env'))
