// Standalone tile world server — HTTP (serves viewer + tile assets) + WS (pushes occupancy).
// Started on demand when the director clicks "Launch Tile World"; a single instance
// lives for the session and is closed when the viewer BrowserWindow is destroyed.
import http from 'http'
import path from 'path'
import fs from 'fs'
import net from 'net'
import { WebSocketServer } from 'ws'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Serve from the project root (two levels up from electron/tileWorld/).
// In the packaged app, tile assets ship under resources/app/src/assets/tiles/.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function mimeFor(ext) {
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.html': 'text/html', '.js': 'text/javascript' }[ext] ?? 'application/octet-stream'
}

export async function startTileWorldServer() {
  const port = await getFreePort()
  const clients = new Set()
  let lastOccupancy = null

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    const pathname = url.pathname

    // Viewer HTML
    if (pathname === '/' || pathname === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'viewer.html'), 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html.replace('__WS_PORT__', String(port)))
      return
    }

    // Tile assets: /tiles/** → src/assets/tiles/**
    if (pathname.startsWith('/tiles/')) {
      const rel = pathname.slice('/tiles/'.length)
      const file = path.join(PROJECT_ROOT, 'src', 'assets', 'tiles', rel)
      if (!file.startsWith(path.join(PROJECT_ROOT, 'src', 'assets', 'tiles'))) {
        res.writeHead(403); res.end(); return
      }
      try {
        const data = fs.readFileSync(file)
        res.writeHead(200, { 'Content-Type': mimeFor(path.extname(file)) })
        res.end(data)
      } catch {
        res.writeHead(404); res.end()
      }
      return
    }

    res.writeHead(404); res.end()
  })

  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', (ws) => {
    clients.add(ws)
    // Send current state immediately on connect
    if (lastOccupancy) ws.send(JSON.stringify(lastOccupancy))
    ws.on('close', () => clients.delete(ws))
  })

  await new Promise((resolve, reject) => {
    httpServer.listen(port, '127.0.0.1', resolve)
    httpServer.on('error', reject)
  })

  return {
    port,
    broadcast(occupancy) {
      lastOccupancy = occupancy
      const msg = JSON.stringify(occupancy)
      for (const ws of clients) {
        if (ws.readyState === 1) ws.send(msg)
      }
    },
    close() {
      for (const ws of clients) ws.terminate()
      wss.close()
      httpServer.close()
    },
  }
}
