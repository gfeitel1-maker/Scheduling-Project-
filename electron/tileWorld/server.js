// Standalone tile world server — HTTP (serves viewer + camp map) + WS (pushes occupancy).
// Started on demand when the director clicks "Open Tile World"; a single instance
// lives for the session and is closed when the viewer BrowserWindow is destroyed.
import http from 'http'
import path from 'path'
import fs from 'fs'
import net from 'net'
import { WebSocketServer } from 'ws'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

export async function startTileWorldServer() {
  const port = await getFreePort()
  const clients = new Set()
  let lastOccupancy = null
  // Cache the map image pushed from the renderer so /map can serve it.
  let cachedMap = null // { data: base64string, mime: string }

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    const pathname = url.pathname

    if (pathname === '/' || pathname === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'viewer.html'), 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html.replace('__WS_PORT__', String(port)))
      return
    }

    // Serve the camp map image from the latest push payload.
    if (pathname === '/map') {
      if (!cachedMap) { res.writeHead(404); res.end(); return }
      const buf = Buffer.from(cachedMap.data, 'base64')
      res.writeHead(200, {
        'Content-Type': cachedMap.mime,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
      })
      res.end(buf)
      return
    }

    res.writeHead(404); res.end()
  })

  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', (ws) => {
    clients.add(ws)
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
      // Extract and cache the map image separately so /map can serve it without
      // sending a potentially large base64 blob down the WS to the viewer.
      if (occupancy.mapImage) cachedMap = occupancy.mapImage
      lastOccupancy = { ...occupancy, mapImage: undefined }
      const msg = JSON.stringify(lastOccupancy)
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
