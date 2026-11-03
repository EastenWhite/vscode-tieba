import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'

let blacklistFile = ''

// 黑名单文件放在扩展的全局存储目录, 首次使用时创建
export function initBlacklist(context: vscode.ExtensionContext) {
  const dir = context.globalStorageUri.fsPath
  if(!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  blacklistFile = path.join(dir, 'blacklist.txt')
  if(!fs.existsSync(blacklistFile)) {
    fs.writeFileSync(blacklistFile, '', 'utf8')
  }
}

export function getBlacklistPath(): string {
  return blacklistFile
}

// 读取黑名单, 每行一个贴名, 忽略空行
export function readBlacklist(): string[] {
  try {
    if(!blacklistFile) {
      return []
    }
    return fs.readFileSync(blacklistFile, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => !!line)
  } catch(err) {
    console.error('读取黑名单失败', err)
    return []
  }
}

// 追加一个贴名到末行, 已存在则不重复写入
export function addToBlacklist(title: string) {
  const name = title.trim()
  if(!name || !blacklistFile || readBlacklist().includes(name)) {
    return
  }
  try {
    const content = fs.readFileSync(blacklistFile, 'utf8')
    const prefix = content && !/\n$/.test(content) ? content + '\n' : content
    fs.writeFileSync(blacklistFile, prefix + name + '\n', 'utf8')
  } catch(err) {
    console.error('写入黑名单失败', err)
  }
}

// 打开黑名单文件供编辑
export async function openBlacklist() {
  if(!blacklistFile) {
    return
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(blacklistFile))
  await vscode.window.showTextDocument(doc)
}
