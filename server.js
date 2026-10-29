import http from 'node:http';
import { readFile, mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
export const norm = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const winner = (v, f) => v > f ? 'Vasco' : v < f ? 'Flamengo' : 'Empate';
const initial = () => ({ palpites: [], premio: 'Prêmio a definir', prazo: '', fechado: false, resultado: null });
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (value, max, required = false) => {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw fail(400, 'Texto inválido.');
  return value.trim();
};
const score = value => {
  if (!Number.isInteger(value) || value < 0 || value > 15) throw fail(400, 'Os gols devem ser números inteiros entre 0 e 15.');
  return value;
};
export function points(p, r) {
  if (!r) return 0;
  return (p.v === r.v && p.f === r.f ? 10 : 0) + (p.w === winner(r.v, r.f) ? 5 : 0) + (p.gol && r.gols.includes(norm(p.gol)) ? 3 : 0);
}
export async function createApp({ dataDir = process.env.DATA_DIR || path.join(root, 'data'), password = process.env.ADMIN_PASSWORD, secureCookie = process.env.NODE_ENV === 'production' } = {}) {
  if (!password || password.length < 12) throw new Error('Defina ADMIN_PASSWORD com pelo menos 12 caracteres.');
  await mkdir(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'bolao.json');
  let db;
  try {
    db = JSON.parse(await readFile(dbFile, 'utf8'));
    if (!db || !Array.isArray(db.palpites) || typeof db.premio !== 'string' || typeof db.prazo !== 'string' || typeof db.fechado !== 'boolean' || !(db.resultado === null || (Number.isInteger(db.resultado?.v) && Number.isInteger(db.resultado?.f) && Array.isArray(db.resultado?.gols)))) throw new Error('Estrutura de dados inválida');
    if (db.prazo && !Number.isFinite(Date.parse(db.prazo))) throw new Error('Prazo inválido');
    const names = new Set();
    for (const p of db.palpites) {
      text(p.nome, 70, true); text(p.gol, 80); score(p.v); score(p.f);
      if (p.w !== winner(p.v, p.f) || !Number.isFinite(p.at) || names.has(norm(p.nome))) throw new Error('Palpite inválido');
      names.add(norm(p.nome));
    }
    if (db.resultado) { score(db.resultado.v); score(db.resultado.f); db.resultado.gols.forEach(gol => text(gol, 1000)); }
    // Aceita somente campos da aplicação, mesmo ao restaurar um arquivo externo.
    db = Object.fromEntries(Object.keys(initial()).map(key => [key, db[key]]));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Não foi possível ler ${dbFile}. Restaure um backup válido.`, { cause: error });
    db = initial();
    await persist(db);
  }
  async function persist(next) {
    const tmp = `${dbFile}.tmp`;
    const file = await open(tmp, 'w', 0o600);
    try { await file.writeFile(JSON.stringify(next, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
    await rename(tmp, dbFile);
  }
  let queue = Promise.resolve();
  function mutate(fn) {
    const task = queue.then(async () => {
      const next = structuredClone(db);
      fn(next);
      await persist(next);
      db = next;
    });
    queue = task.catch(() => {});
    return task;
  }
  const sessions = new Map();
  // Limite global também funciona atrás do proxy, sem confiar em IPs enviados pelo cliente.
  let attempts = [];
  const passwordHash = createHash('sha256').update(password).digest();
  const closed = state => state.fechado || !!state.resultado || !!(state.prazo && Date.now() >= Date.parse(state.prazo));
  function publicState() {
    const ranked = [...db.palpites].sort((a, b) => points(b, db.resultado) - points(a, db.resultado) || Number(b.v === db.resultado?.v && b.f === db.resultado?.f) - Number(a.v === db.resultado?.v && a.f === db.resultado?.f) || a.at - b.at);
    return { ...db, encerrado: closed(db), ranking: ranked.map(p => ({ ...p, pontos: points(p, db.resultado) })) };
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      if (req.method === 'GET' && route === '/health') return send(200, { status: 'ok' });
      if (req.method === 'GET' && (route === '/' || route === '/index.html' || route === '/app.js')) {
        const filename = route === '/app.js' ? 'app.js' : 'index.html';
        const content = await readFile(path.join(root, filename));
        res.writeHead(200, { 'Content-Type': filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
        return res.end(content);
      }
      if (!route.startsWith('/api/')) return send(404, { error: 'Não encontrado.' });
      if (req.method === 'GET' && route === '/api/state') return send(200, publicState());
      const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('session='))?.slice(8);
      const authenticated = sessions.has(token) && sessions.get(token) > Date.now();
      if (token && !authenticated) sessions.delete(token);
      if (req.method === 'GET' && route === '/api/export') {
        if (!authenticated) throw fail(401, 'Entre como organizador.');
        res.setHeader('Content-Disposition', 'attachment; filename="bolao-familia.json"');
        return send(200, db);
      }
      if (req.method !== 'POST') throw fail(405, 'Método não permitido.');
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw fail(403, 'Origem não permitida.');
      if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'Envie JSON.');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16384) throw fail(413, 'Requisição muito grande.');
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'JSON inválido.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'JSON inválido.');
      if (route === '/api/login') {
        attempts = attempts.filter(at => at > Date.now() - 60000);
        if (attempts.length >= 10) throw fail(429, 'Muitas tentativas. Aguarde um minuto.');
        attempts.push(Date.now());
        const candidate = createHash('sha256').update(typeof body.password === 'string' ? body.password : '').digest();
        if (!timingSafeEqual(candidate, passwordHash)) throw fail(401, 'Senha incorreta.');
        for (const [key, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(key);
        const session = randomBytes(32).toString('hex');
        sessions.set(session, Date.now() + 8 * 3600000);
        res.setHeader('Set-Cookie', `session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie ? '; Secure' : ''}`);
        return send(200, { ok: true });
      }
      if (route === '/api/palpites') {
        const nome = text(body.nome, 70, true), gol = text(body.gol ?? '', 80);
        const v = score(body.v), f = score(body.f), w = winner(v, f);
        if (body.w !== w) throw fail(400, 'O vencedor escolhido não corresponde ao placar.');
        await mutate(state => {
          if (closed(state)) throw fail(409, 'Palpites encerrados.');
          if (state.palpites.some(p => norm(p.nome) === norm(nome))) throw fail(409, 'Este nome já registrou um palpite.');
          state.palpites.push({ nome, v, f, w, gol, at: Date.now() });
        });
        return send(201, publicState());
      }
      if (!authenticated) throw fail(401, 'Entre como organizador.');
      if (route === '/api/config') {
        const premio = text(body.premio, 200);
        const prazo = text(body.prazo, 40);
        if (prazo && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(prazo) || !Number.isFinite(Date.parse(prazo)))) throw fail(400, 'Prazo inválido.');
        if (typeof body.fechado !== 'boolean') throw fail(400, 'Configuração inválida.');
        await mutate(state => Object.assign(state, { premio, prazo, fechado: body.fechado }));
      } else if (route === '/api/resultado') {
        const v = score(body.v), f = score(body.f);
        const gols = text(body.goleadores ?? '', 1000).split(',').map(norm).filter(Boolean);
        await mutate(state => { state.resultado = { v, f, gols }; state.fechado = true; });
      } else if (route === '/api/reset') {
        await mutate(state => Object.assign(state, initial()));
      } else if (route === '/api/logout') {
        sessions.delete(token);
        res.setHeader('Set-Cookie', `session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie ? '; Secure' : ''}`);
      } else throw fail(404, 'Não encontrado.');
      return send(200, publicState());
    } catch (error) {
      if (!error.status) console.error(error);
      if (!res.headersSent) send(error.status || 500, { error: error.status ? error.message : 'Não foi possível salvar ou carregar os dados. Tente novamente.' });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createApp();
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`Bolão disponível na porta ${process.env.PORT || 3000}`));
}
