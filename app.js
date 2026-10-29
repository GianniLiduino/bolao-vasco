const $ = id => document.getElementById(id);
let db = { palpites: [], ranking: [] };
let auth = false;
let busy = false;
function tab(t) {
  ['palpites', 'ranking', 'admin'].forEach(x => $(x).classList.toggle('hide', x !== t));
  refresh();
}
for (let i = 0; i <= 15; i++) ['vg', 'fg', 'rv', 'rf'].forEach(id => $(id).add(new Option(i, i)));
function resetGuess() {
  $('form').reset();
  $('vg').value = '1'; $('fg').value = '1'; $('vencedor').value = 'Empate';
}
resetGuess();
async function api(route, data) {
  const response = await fetch(`/api/${route}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401 && route !== 'login') { auth = false; $('controls').classList.add('hide'); }
    throw new Error(value.error || 'Erro na comunicação com o servidor.');
  }
  return value;
}
function render() {
  $('premioInfo').textContent = '🏆 Prêmio: ' + db.premio;
  $('status').textContent = db.encerrado ? 'Palpites encerrados.' : db.prazo ? 'Palpites abertos até ' + new Date(db.prazo).toLocaleString('pt-BR') + '.' : 'Palpites abertos.';
  $('form').querySelector('button').disabled = db.encerrado || busy;
  $('lista').replaceChildren(...db.ranking.map((p, i) => {
    const tr = document.createElement('tr');
    [i + 1, p.nome, p.pontos, `${p.v} × ${p.f}`].forEach(value => { const td = document.createElement('td'); td.textContent = value; tr.append(td); });
    return tr;
  }));
  if (!db.ranking.length) $('lista').innerHTML = '<tr><td colspan="4">Ainda não há palpites.</td></tr>';
  $('oficial').textContent = db.resultado ? `Resultado oficial: Vasco ${db.resultado.v} × ${db.resultado.f} Flamengo` : 'Aguardando resultado oficial.';
}
async function refresh() {
  try { db = await api('state'); render(); $('connection').textContent = ''; }
  catch { $('connection').textContent = 'Não foi possível atualizar os dados. Confira sua conexão.'; }
}
async function action(fn) {
  if (busy) return;
  busy = true;
  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach(b => b.disabled = true);
  try { await fn(); } catch (error) { alert(error.message); }
  finally { busy = false; buttons.forEach(b => b.disabled = false); render(); }
}
$('form').onsubmit = e => {
  e.preventDefault();
  action(async () => {
    db = await api('palpites', { nome: $('nome').value.trim(), v: +$('vg').value, f: +$('fg').value, w: $('vencedor').value, gol: $('artilheiro').value.trim() });
    $('msg').textContent = 'Palpite salvo! Todos os participantes já podem vê-lo.';
    resetGuess();
  });
};
function entrar() {
  action(async () => {
    await api('login', { password: $('senha').value });
    $('senha').value = '';
    auth = true;
    db = await api('state');
    $('controls').classList.remove('hide');
    $('premio').value = db.premio;
    const date = db.prazo ? new Date(db.prazo) : null;
    $('prazo').value = date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    $('fechado').checked = db.fechado;
    $('rv').value = db.resultado?.v ?? 0;
    $('rf').value = db.resultado?.f ?? 0;
    $('goleadores').value = db.resultado?.gols.join(', ') ?? '';
  });
}
function configurar() {
  if (!auth) return;
  action(async () => {
    db = await api('config', { premio: $('premio').value, prazo: $('prazo').value ? new Date($('prazo').value).toISOString() : '', fechado: $('fechado').checked });
    alert('Configurações salvas.');
  });
}
function resultado() {
  if (!auth) return;
  action(async () => { db = await api('resultado', { v: +$('rv').value, f: +$('rf').value, goleadores: $('goleadores').value }); $('fechado').checked = true; alert('Resultado publicado e palpites encerrados!'); });
}
function exportar() { if (auth) window.location.assign('/api/export'); }
function limpar() {
  if (!auth || !confirm('Apagar TODOS os palpites, resultado e configurações? Exporte um backup antes de continuar.')) return;
  action(async () => { db = await api('reset', {}); $('premio').value = db.premio; $('prazo').value = ''; $('fechado').checked = false; $('rv').value = '0'; $('rf').value = '0'; $('goleadores').value = ''; $('msg').textContent = ''; });
}
function sair() { action(async () => { await api('logout', {}); auth = false; $('controls').classList.add('hide'); }); }
refresh();
setInterval(refresh, 15000);
