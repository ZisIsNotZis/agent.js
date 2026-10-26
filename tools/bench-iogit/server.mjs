import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve('public')
const PORT = 8140
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    let p = decodeURIComponent(url.pathname)
    if (p === '/') p = '/index.html'
    const file = path.join(ROOT, p)
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('no')
      return
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('404 ' + p)
        return
      }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
        // OPFS + these APIs need a secure context: 127.0.0.1 counts.
      })
      res.end(buf)
    })
  })
  .listen(PORT, '127.0.0.1', () => console.log('serving ' + ROOT + ' on http://127.0.0.1:' + PORT + '/'))
