// Kleiner Webserver zum Testen im Browser: npm run serve
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const port = Number(process.env.PORT || 8080);
createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([.][.][/\\])+/, '');
  const file = join(root, p.endsWith('/') ? p + 'index.html' : p);
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, () => console.log(`http://localhost:${port}/`));
