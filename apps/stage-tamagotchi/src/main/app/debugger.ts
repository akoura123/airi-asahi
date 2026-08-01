import http from 'node:http'

import { env } from 'node:process'

import { app, BrowserWindow } from 'electron'

interface RemoteDebugTarget {
  type?: string
  url?: string
  webSocketDebuggerUrl?: string
}

function fetchRemoteDebugTargets(remoteDebugEndpoint: string): Promise<RemoteDebugTarget[]> {
  return new Promise((resolve, reject) => {
    http.get(`${remoteDebugEndpoint}/json`, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as RemoteDebugTarget[])
        }
        catch (err) {
          reject(err)
        }
      })
    }).on('error', reject)
  })
}

function selectInspectableTarget(targets: RemoteDebugTarget[]) {
  const inspectableTargets = targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl && !target.url?.startsWith('devtools://'))
  return inspectableTargets.find(target => target.url?.endsWith('/#/'))
    ?? inspectableTargets.find(target => target.url?.includes('/#/') && !target.url?.includes('/onboarding'))
    ?? inspectableTargets[0]
}

async function waitForMainTarget(remoteDebugEndpoint: string) {
  let targets: RemoteDebugTarget[] = []

  // The BeatSync background window is created before the visible main window.
  // Wait briefly for the main renderer so remote debugging does not open the
  // hidden troubleshooting page by accident.
  for (let attempt = 0; attempt < 20; attempt++) {
    targets = await fetchRemoteDebugTargets(remoteDebugEndpoint)
    const target = selectInspectableTarget(targets)
    if (target?.url?.endsWith('/#/'))
      return target

    if (attempt < 19)
      await new Promise(resolve => setTimeout(resolve, 100))
  }

  return selectInspectableTarget(targets)
}

export function setupDebugger() {
  if (/^true$/i.test(env.APP_REMOTE_DEBUG || '')) {
    const remoteDebugPort = Number(env.APP_REMOTE_DEBUG_PORT || '9222')
    if (Number.isNaN(remoteDebugPort) || !Number.isInteger(remoteDebugPort) || remoteDebugPort < 0 || remoteDebugPort > 65535) {
      throw new Error(`Invalid remote debug port: ${env.APP_REMOTE_DEBUG_PORT}`)
    }

    app.commandLine.appendSwitch('remote-debugging-port', String(remoteDebugPort))
    app.commandLine.appendSwitch('remote-allow-origins', `http://localhost:${remoteDebugPort}`)
  }
}

export async function openDebugger() {
  if (!/^true$/i.test(env.APP_REMOTE_DEBUG || ''))
    return

  const remoteDebugEndpoint = `http://localhost:${env.APP_REMOTE_DEBUG_PORT || '9222'}`

  try {
    const target = await waitForMainTarget(remoteDebugEndpoint)
    if (!target) {
      console.warn('[Remote Debugging] No inspectable page targets found')
      return
    }

    let wsUrl = target.webSocketDebuggerUrl
    if (!wsUrl?.startsWith('ws://')) {
      console.warn('[Remote Debugging] Invalid WebSocket URL:', wsUrl)
      return
    }

    wsUrl = wsUrl.substring(5)
    const inspectorUrl = `${remoteDebugEndpoint}/devtools/inspector.html?ws=${wsUrl}`
    console.info(`Inspect remotely: ${inspectorUrl}`)

    const debuggerWindow = new BrowserWindow({
      title: 'AIRI Remote Debugger',
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      center: true,
      resizable: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
      },
    })

    debuggerWindow.on('page-title-updated', (event) => {
      event.preventDefault()
      debuggerWindow.setTitle('AIRI Remote Debugger')
    })
    debuggerWindow.once('ready-to-show', () => debuggerWindow.show())
    try {
      await debuggerWindow.loadURL(inspectorUrl)
    }
    catch (err) {
      debuggerWindow.close()
      throw err
    }
  }
  catch (err) {
    console.error('[Remote Debugging] Failed to open inspector:', err)
  }
}
