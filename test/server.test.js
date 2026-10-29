import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, points } from '../server.js';

const password = 'uma-senha-de-teste-segura';
async function listen(dataDir) {
  const server = await createApp({ dataDir, password, secureCookie: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, body, cookie, headers = {}) {
    const res = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  return { request, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
const guess = (nome, extra = {}) => ({ nome, v: 2, f: 1, w: 'Vasco', gol: 'João', ...extra });

test('persistência, concorrência, autenticação, regras e reinício do servidor', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bolao-test-'));
  let app = await listen(dataDir);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const call = (...args) => app.request(...args);
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call('/api/state')).body.palpites.length, 0);
  for (const route of ['/api/config', '/api/resultado', '/api/reset']) assert.equal((await call(route, {})).status, 401);
  assert.equal((await call('/api/export')).status, 401);
  assert.equal((await call('/api/login', { password: 'errada' })).status, 401);
  assert.equal((await call('/api/login', { password }, null, { Origin: 'https://outro-site.com' })).status, 403);
  const login = await call('/api/login', { password });
  assert.equal(login.status, 200);
  const cookie = login.cookie;
  assert.ok(cookie);
  assert.equal((await call('/api/palpites', guess(''))).status, 400);
  assert.equal((await call('/api/palpites', guess('Inválido', { v: 16 }))).status, 400);
  assert.equal((await call('/api/palpites', guess('Inválido', { w: 'Empate' }))).status, 400);
  assert.equal((await call('/api/palpites', guess('José'))).status, 201);
  assert.equal((await call('/api/palpites', guess(' JOSE '))).status, 409);
  const duplicate = await Promise.all([call('/api/palpites', guess('Maria')), call('/api/palpites', guess('Maria'))]);
  assert.deepEqual(duplicate.map(r => r.status).sort(), [201, 409]);
  const many = await Promise.all(Array.from({ length: 12 }, (_, i) => call('/api/palpites', guess(`Pessoa ${i}`))));
  assert.ok(many.every(r => r.status === 201));
  const saved = JSON.parse(await readFile(path.join(dataDir, 'bolao.json'), 'utf8'));
  assert.equal(saved.palpites.length, 14);
  assert.equal(JSON.stringify(saved).includes(password), false);
  assert.equal((await call('/api/config', { premio: 'Camisa', prazo: 'inválido', fechado: false }, cookie)).status, 400);
  const past = new Date(Date.now() - 60000).toISOString();
  assert.equal((await call('/api/config', { premio: 'Camisa', prazo: past, fechado: false }, cookie)).status, 200);
  assert.equal((await call('/api/palpites', guess('Tarde'))).status, 409);
  await call('/api/config', { premio: 'Camisa', prazo: '', fechado: true }, cookie);
  assert.equal((await call('/api/palpites', guess('Fechado'))).status, 409);
  await call('/api/config', { premio: 'Camisa', prazo: '', fechado: false }, cookie);
  assert.equal((await call('/api/palpites', guess('Outro', { v: 3, gol: '' }))).status, 201);
  const result = await call('/api/resultado', { v: 2, f: 1, goleadores: 'JOAO' }, cookie);
  assert.equal(result.body.ranking[0].nome, 'José');
  assert.equal(result.body.ranking[0].pontos, 18);
  assert.equal(result.body.ranking.at(-1).pontos, 5);
  assert.equal((await call('/api/palpites', guess('Após resultado'))).status, 409);
  const exported = await call('/api/export', undefined, cookie);
  assert.equal(exported.body.palpites.length, 15);
  await app.close();
  app = await listen(dataDir);
  const reloaded = await call('/api/state');
  assert.equal(reloaded.body.palpites.length, 15);
  assert.equal(reloaded.body.premio, 'Camisa');
  assert.equal(reloaded.body.ranking[0].pontos, 18);
  assert.equal((await call('/api/reset', {}, cookie)).status, 401);
  const cookie2 = (await call('/api/login', { password })).cookie;
  assert.equal((await call('/api/logout', {}, cookie2)).status, 200);
  assert.equal((await call('/api/reset', {}, cookie2)).status, 401);
  const cookie3 = (await call('/api/login', { password })).cookie;
  assert.equal((await call('/api/reset', {}, cookie3)).body.palpites.length, 0);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'bolao.json'), 'utf8')).resultado, null);
});

test('arquivo inválido não é sobrescrito', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bolao-corrupt-'));
  try {
    await writeFile(path.join(dataDir, 'bolao.json'), 'arquivo inválido');
    await assert.rejects(createApp({ dataDir, password }), /backup válido/);
    assert.equal(await readFile(path.join(dataDir, 'bolao.json'), 'utf8'), 'arquivo inválido');
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('pontuação cumulativa e empate', () => {
  assert.equal(points(guess('A'), null), 0);
  assert.equal(points(guess('A'), { v: 2, f: 1, gols: ['joao'] }), 18);
  assert.equal(points(guess('A', { v: 1, f: 1, w: 'Empate', gol: '' }), { v: 1, f: 1, gols: [] }), 15);
  assert.equal(points(guess('A', { w: 'Flamengo', v: 0, f: 1 }), { v: 2, f: 1, gols: [] }), 0);
});

test('senha obrigatória e limite de tentativas', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bolao-auth-'));
  await assert.rejects(createApp({ dataDir, password: 'curta' }), /12 caracteres/);
  const app = await listen(dataDir);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  for (let i = 0; i < 10; i++) assert.equal((await app.request('/api/login', { password: 'errada' })).status, 401);
  assert.equal((await app.request('/api/login', { password })).status, 429);
});
