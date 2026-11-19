import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { recentHarnessProjects } from './recent-sessions.mjs'

export async function chooseDesktopProject(defaultProject) {
  if (!process.stdin.isTTY) return defaultProject
  const projects = await recentHarnessProjects()
  console.log('选择要在手机上打开的项目。回车使用 ' + defaultProject)
  projects.forEach(({ path }, i) => console.log('  ' + (i + 1) + '  ' + path))
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const input = (await terminal.question('输入项目编号或文件夹路径，按回车启动：')).trim()
      if (!input) return defaultProject
      if (!/^\d+$/u.test(input)) return input.replace(/^"(.*)"$/u, '$1')
      if (projects[Number(input) - 1]) return projects[Number(input) - 1].path
      console.log('请输入列表中的编号。')
    }
  } finally { terminal.close() }
}

export async function runningDesktop(port) {
  const origin = 'http://127.0.0.1:' + port
  let data
  try {
    const response = await fetch(origin + '/v1/control', {
      method: 'POST', headers: { Origin: origin }, redirect: 'error', signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return false
    data = await response.json()
  } catch { return false }
  if (typeof data?.token !== 'string' || !Array.isArray(data.addresses)) return false
  if (!data.desktopLibrary) throw new Error('此端口运行的是单项目或旧版 Work 服务。请在原服务窗口按 Ctrl+C，再运行 Start-Desktop.cmd 同步所有工作区。')
  if (!data.addresses.some(address => !address.startsWith('http://127.'))) {
    throw new Error('当前服务没有手机可访问的局域网地址。请确认电脑已连上局域网，在原服务窗口按 Ctrl+C，再运行 Start-Desktop.cmd。')
  }
  return true
}

export function openDesktopControl(port) {
  const url = 'http://127.0.0.1:' + port + '/control'
  const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(opener, [url], { stdio: 'ignore', windowsHide: true })
  child.on('error', () => console.log('请在电脑浏览器打开 ' + url))
  child.unref()
}
