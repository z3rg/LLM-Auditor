'use strict';
// ---------------------------------------------------------------------------
// LLM Auditor — frontend
// ---------------------------------------------------------------------------
const state = {
  role: null,
  config: { model: '', aiProvider: '', gapThreshold: 70 },
  lastGap: null,        // { scope_type, scope_ref, scope_label }
  lastAiMarkdown: '',
  lastQuizTopics: null,
};
const ROLE_META = {
  super_admin: { icon: '🛡️', name: 'Super Admin' },
  auditor: { icon: '🔎', name: 'IT Auditor' },
  director: { icon: '✅', name: 'Direktur' },
  participant: { icon: '👤', name: 'Peserta Audit' },
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Id percakapan Makers — WAJIB pada setiap request ke Agent Functions.
 *
 * Runtime agent menolak request tanpa header ini dengan 400 ("Invalid
 * makers-conversation-id"), jadi tanpa ini seluruh aplikasi mati di browser,
 * termasuk daftar divisi di formulir pendaftaran.
 *
 * Nilainya ditahan di localStorage supaya satu browser tetap dilayani instance
 * agent yang sama (Session mode) — cache dalam proses di sisi server jadi
 * benar-benar terpakai. Format yang diterima: 6-36 karakter [0-9a-zA-Z-_.].
 */
const CONVERSATION_KEY = 'llm-auditor-conversation-id';
function conversationId() {
  try {
    let id = localStorage.getItem(CONVERSATION_KEY);
    if (id && /^[0-9a-zA-Z\-_.]{6,36}$/.test(id)) return id;
    id = (crypto.randomUUID && crypto.randomUUID()) || `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(CONVERSATION_KEY, id);
    return id;
  } catch (_) {
    // Mode privat / storage diblokir: id sekali pakai tetap lebih baik daripada 400.
    return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function api(path, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'makers-conversation-id': conversationId(),
    ...(opts.headers || {}),
  };
  return fetch(path, { credentials: 'same-origin', ...opts, headers }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Sesi kedaluwarsa saat aplikasi terbuka: kembalikan ke layar masuk.
      if (r.status === 401 && state.role && !path.startsWith('/api/auth/')) sessionExpired();
      throw new Error(data.error || `HTTP ${r.status}`);
    }
    return data;
  });
}

function sessionExpired() {
  state.role = null;
  showAuth();
  formMsg('#loginMsg', 'Sesi Anda berakhir. Masuk kembali untuk melanjutkan.', 'error');
}

function scoreClass(v) { return v >= 80 ? 'good' : v >= 70 ? 'info' : v >= 55 ? 'warn' : 'bad'; }
function scoreColor(v) { return v >= 80 ? '#34d399' : v >= 70 ? '#5b8cff' : v >= 55 ? '#fbbf24' : '#f87171'; }

// Minimal markdown -> HTML (headings, bold, lists, code, paragraphs)
function md(src) {
  const lines = String(src).split('\n');
  let html = '', inUl = false, inOl = false;
  const closeLists = () => { if (inUl) { html += '</ul>'; inUl = false; } if (inOl) { html += '</ol>'; inOl = false; } };
  const inline = (t) => esc(t)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  for (let raw of lines) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { closeLists(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; }
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { if (!inUl) { closeLists(); html += '<ul>'; inUl = true; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { if (!inOl) { closeLists(); html += '<ol>'; inOl = true; } html += `<li>${inline(m[1])}</li>`; }
    else if (line.trim() === '') { closeLists(); }
    else { closeLists(); html += `<p>${inline(line)}</p>`; }
  }
  closeLists();
  return html;
}

// ---------------------------------------------------------------------------
// Masuk / Daftar
// ---------------------------------------------------------------------------
/** Server roles -> UI roles used for nav gating. */
const uiRole = (role) => (role === 'employee' ? 'participant' : role);

// Kertas kerja kiri: kosong saat mode masuk (peran & cakupan akses tidak
// diumbar sebelum login), berisi register kontrol saat mode daftar.
const REG_CONTROLS = [
  ['1.1', 'Nama lengkap terisi', () => $('#regName').value.trim().length >= 3],
  ['1.2', 'Email berformat valid', () => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test($('#regEmail').value.trim())],
  ['1.3', 'Divisi ditetapkan', () => !!$('#regDivision').value],
  ['1.4', 'Kata sandi 8+ karakter, memuat angka', () => {
    const v = $('#regPassword').value; return v.length >= 8 && /\d/.test(v);
  }],
  ['1.5', 'Konfirmasi kata sandi cocok', () => {
    const v = $('#regPassword').value; return v.length > 0 && v === $('#regConfirm').value;
  }],
];

let authMode = 'login';

function renderRegister() {
  const rows = $('#registerRows');
  const panel = $('#paperRegister');
  if (authMode === 'login') {
    panel.classList.add('hidden');
    rows.innerHTML = '';
    setStamp('idle', 'Akses terkendali', 'sesi aman · 7 hari');
    return;
  }
  panel.classList.remove('hidden');
  const met = REG_CONTROLS.map(([, , test]) => { try { return test(); } catch (_) { return false; } });
  const doneCount = met.filter(Boolean).length;
  $('#registerTitle').textContent = 'Kontrol pendaftaran';
  $('#registerCount').textContent = `${doneCount} / ${REG_CONTROLS.length} terpenuhi`;
  rows.innerHTML = REG_CONTROLS.map(([no, label], i) => `
    <li class="reg-row${met[i] ? ' is-met' : ''}">
      <span class="no">${no}</span>
      <span class="what">${esc(label)}</span>
      <span class="mark">${met[i] ? '✓ sesuai' : 'belum'}</span>
    </li>`).join('');
  if (doneCount === REG_CONTROLS.length) setStamp('verified', 'Kontrol terpenuhi', 'siap dikirim');
  else setStamp('pending', 'Belum lengkap', `${doneCount} dari ${REG_CONTROLS.length} kontrol`);
}

let stampState = '';
function setStamp(stateName, line1, line2) {
  const stamp = $('#authStamp');
  $('#stampLine1').textContent = line1;
  $('#stampLine2').textContent = line2;
  if (stampState === stateName) return;   // jangan ulang animasi tiap ketikan
  stampState = stateName;
  stamp.dataset.state = stateName;
}

function setAuthMode(mode) {
  authMode = mode;
  $('.paper').dataset.mode = mode;   // menentukan penempatan stempel di kertas kerja
  $('#loginForm').classList.toggle('hidden', mode !== 'login');
  $('#registerForm').classList.toggle('hidden', mode !== 'register');
  $$('.mode-tab').forEach((t) => {
    const on = t.dataset.mode === mode;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  moveUnderline();
  renderRegister();
  if (mode === 'register') loadRegisterDivisions();
  const first = mode === 'login' ? $('#loginEmail') : $('#regName');
  if (document.activeElement && document.activeElement.closest('#auth')) first.focus();
}

function moveUnderline() {
  const active = $('.mode-tab.is-active');
  const bar = $('#modeUnderline');
  if (!active || !bar) return;
  bar.style.width = `${active.offsetWidth}px`;
  bar.style.transform = `translateX(${active.offsetLeft}px)`;
}

let divisionsLoaded = false;
async function loadRegisterDivisions() {
  if (divisionsLoaded) return;
  try {
    const list = await api('/api/auth/divisions');
    $('#regDivision').innerHTML = '<option value="">Pilih divisi</option>' +
      list.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    divisionsLoaded = true;
  } catch (_) {
    $('#regDivision').innerHTML = '<option value="">Gagal memuat divisi — muat ulang halaman</option>';
  }
}

function formMsg(id, text, kind) {
  const box = $(id);
  box.className = `form-msg${kind ? ` is-${kind}` : ''}`;
  box.textContent = text || '';
}

$$('.mode-tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));
$$('#auth [data-goto]').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.goto)));
$$('#auth .pw-toggle').forEach((btn) => btn.addEventListener('click', () => {
  const input = $(`#${btn.dataset.target}`);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Sembunyikan' : 'Lihat';
}));
$('#registerForm').addEventListener('input', renderRegister);
window.addEventListener('resize', moveUnderline);

$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('#loginSubmit');
  formMsg('#loginMsg', '');
  btn.disabled = true; btn.textContent = 'Memeriksa…';
  try {
    const { user } = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#loginEmail').value, password: $('#loginPassword').value }),
    });
    await enterApp(user);
  } catch (e) {
    formMsg('#loginMsg', e.message, 'error');
    btn.disabled = false; btn.textContent = 'Masuk';
  }
});

$('#registerForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('#registerSubmit');
  formMsg('#registerMsg', '');
  if ($('#regPassword').value !== $('#regConfirm').value) {
    return formMsg('#registerMsg', 'Konfirmasi kata sandi belum cocok.', 'error');
  }
  btn.disabled = true; btn.textContent = 'Membuat akun…';
  try {
    const { user } = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#regName').value,
        email: $('#regEmail').value,
        password: $('#regPassword').value,
        division_id: Number($('#regDivision').value),
      }),
    });
    await enterApp(user);
  } catch (e) {
    formMsg('#registerMsg', e.message, 'error');
    btn.disabled = false; btn.textContent = 'Buat akun';
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  location.reload();
});

function showAuth() {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  setAuthMode('login');
  moveUnderline();
}

async function enterApp(user) {
  state.user = user;
  state.role = uiRole(user.role);
  state.employeeId = user.id;
  state.employeeName = user.name;
  const role = state.role;
  try { state.config = await api('/api/config'); } catch (_) {}
  const meta = ROLE_META[role] || ROLE_META.participant;
  $('#roleIcon').textContent = meta.icon;
  $('#roleName').textContent = user.name;
  $('#modelName').textContent = user.division ? `${meta.name} · ${user.division}` : meta.name;
  // generic role-gated nav: show items whose data-roles includes this role
  let firstTab = null;
  $$('.nav-item[data-tab]').forEach((n) => {
    const allowed = (n.dataset.roles || '').split(',').includes(role);
    n.style.display = allowed ? '' : 'none';
    n.classList.remove('active');
    if (allowed && !firstTab) firstTab = n;
  });
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  if (role === 'participant') {
    loadNewQuiz();
  } else {
    loadOverview();
    loadScopeOptions();
    loadAcks();
  }
  // activate the first permitted tab
  if (firstTab) {
    firstTab.classList.add('active');
    $$('.tab').forEach((t) => t.classList.add('hidden'));
    $(`#tab-${firstTab.dataset.tab}`).classList.remove('hidden');
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
$$('.nav-item[data-tab]').forEach((n) => n.addEventListener('click', () => {
  $$('.nav-item').forEach((x) => x.classList.remove('active'));
  n.classList.add('active');
  $$('.tab').forEach((t) => t.classList.add('hidden'));
  $(`#tab-${n.dataset.tab}`).classList.remove('hidden');
  if (n.dataset.tab === 'acks') loadAcks();
  if (n.dataset.tab === 'trend') loadTrend();
  if (n.dataset.tab === 'newquiz') loadNewQuiz();
  if (n.dataset.tab === 'settings') loadSettings();
  if (n.dataset.tab === 'account') loadAccount();
}));

// ---------------------------------------------------------------------------
// Akun: profil, ganti kata sandi, pengelolaan peran (Super Admin)
// ---------------------------------------------------------------------------
const ROLE_LABEL = {
  super_admin: 'Super Admin', auditor: 'IT Auditor',
  director: 'Direktur', employee: 'Peserta Audit',
};

function loadAccount() {
  const u = state.user;
  if (!u) return;
  $('#accountProfile').innerHTML = `
    <span>Nama: <strong>${esc(u.name)}</strong></span>
    <span>Email: <strong>${esc(u.email)}</strong></span>
    <span>Divisi: <strong>${esc(u.division || '-')}</strong></span>
    <span>Peran: <span class="pill info">${esc(ROLE_LABEL[u.role] || u.role)}</span></span>`;
  const panel = $('#usersPanel');
  panel.classList.toggle('hidden', u.role !== 'super_admin');
  if (u.role === 'super_admin') loadUsers();
}

$('#passwordForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('#pwMsg');
  msg.innerHTML = '';
  try {
    await api('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ current_password: $('#pwCurrent').value, new_password: $('#pwNew').value }),
    });
    msg.innerHTML = '<div class="notice ok">Kata sandi diperbarui.</div>';
    $('#pwCurrent').value = ''; $('#pwNew').value = '';
  } catch (e) {
    msg.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
  }
});

async function loadUsers() {
  const box = $('#usersTable');
  box.innerHTML = '<span class="spinner"></span> Memuat akun…';
  try {
    const { users, roles } = await api('/api/admin/users');
    box.innerHTML = `
      <div class="scroll-x"><table>
        <thead><tr><th>Nama</th><th>Email</th><th>Divisi</th><th>Peran</th><th>Status</th><th></th></tr></thead>
        <tbody>${users.map((u) => `
          <tr>
            <td>${esc(u.name)}${u.id === state.user.id ? ' <span class="pill muted">Anda</span>' : ''}</td>
            <td><span class="muted">${esc(u.email)}</span></td>
            <td><span class="muted">${esc(u.division)}</span></td>
            <td>
              <select data-role-for="${u.id}"${u.id === state.user.id ? ' disabled' : ''}>
                ${roles.map((r) => `<option value="${r}"${r === u.role ? ' selected' : ''}>${esc(ROLE_LABEL[r] || r)}</option>`).join('')}
              </select>
            </td>
            <td><span class="pill ${u.status === 'active' ? 'good' : 'muted'}">${u.status === 'active' ? 'Aktif' : 'Nonaktif'}</span>
                ${u.active_sessions ? '<span class="pill info">sesi aktif</span>' : ''}</td>
            <td>${u.id === state.user.id ? '' :
              `<button class="btn ghost sm" data-status-for="${u.id}" data-next="${u.status === 'active' ? 'disabled' : 'active'}">${u.status === 'active' ? 'Nonaktifkan' : 'Aktifkan'}</button>`}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;
    box.querySelectorAll('select[data-role-for]').forEach((sel) =>
      sel.addEventListener('change', () => updateUser(`/api/admin/users/${sel.dataset.roleFor}/role`, { role: sel.value })));
    box.querySelectorAll('button[data-status-for]').forEach((btn) =>
      btn.addEventListener('click', () => updateUser(`/api/admin/users/${btn.dataset.statusFor}/status`, { status: btn.dataset.next })));
  } catch (e) {
    box.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
  }
}

async function updateUser(path, body) {
  const msg = $('#usersMsg');
  msg.innerHTML = '';
  try {
    const { user } = await api(path, { method: 'POST', body: JSON.stringify(body) });
    msg.innerHTML = `<div class="notice ok">${esc(user.name)} diperbarui — ${esc(ROLE_LABEL[user.role] || user.role)}, ${user.status === 'active' ? 'aktif' : 'nonaktif'}.</div>`;
    loadUsers();
  } catch (e) {
    msg.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
    loadUsers();
  }
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
async function loadOverview() {
  const o = await api('/api/overview');
  const t = o.totals;
  $('#statCards').innerHTML = '';
  const cards = [
    ['Karyawan', t.employees], ['Divisi', t.divisions], ['Topik Audit', t.topics],
    ['Hasil Kuis', t.attempts], ['Skor Rata-rata', `${t.avgScore}<small>/100</small>`],
  ];
  cards.forEach(([k, v]) => {
    const c = el('div', 'card stat');
    c.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div>`;
    $('#statCards').appendChild(c);
  });
  $('#divBars').innerHTML = '';
  o.byDivision.forEach((d) => $('#divBars').appendChild(bar(d.division, d.avg_score, `${d.gap_attempts} gap`)));
  $('#topicBars').innerHTML = '';
  o.byTopic.forEach((tp) => $('#topicBars').appendChild(bar(tp.topic, tp.avg_score)));
}
function bar(label, value, note) {
  const row = el('div', 'bar-row');
  row.innerHTML =
    `<div class="lbl" title="${esc(label)}">${esc(label)}${note ? ` <span class="muted">· ${esc(note)}</span>` : ''}</div>
     <div class="bar-track"><div class="bar-fill" style="width:${value}%;background:${scoreColor(value)}"></div></div>
     <div class="num">${value}</div>`;
  return row;
}

// ---------------------------------------------------------------------------
// Knowledge Gaps + Feature 1 & 2
// ---------------------------------------------------------------------------
let employees = [], divisions = [], topics = [];
async function loadScopeOptions() {
  [employees, divisions, topics] = await Promise.all([
    api('/api/employees'), api('/api/divisions'), api('/api/topics'),
  ]);
  fillScopeRef();
}
$('#scopeType').addEventListener('change', fillScopeRef);
function fillScopeRef() {
  const type = $('#scopeType').value;
  const sel = $('#scopeRef');
  sel.innerHTML = '';
  const list = type === 'employee'
    ? employees.map((e) => ({ id: e.id, label: `${e.name} — ${e.division}` }))
    : divisions.map((d) => ({ id: d.id, label: d.name }));
  list.forEach((x) => { const o = el('option'); o.value = x.id; o.textContent = x.label; sel.appendChild(o); });
}
$('#loadGaps').addEventListener('click', loadGaps);

async function loadGaps() {
  const type = $('#scopeType').value;
  const id = Number($('#scopeRef').value);
  const label = $('#scopeRef').selectedOptions[0]?.textContent || '';
  const box = $('#gapResult');
  box.innerHTML = '<div class="panel"><span class="spinner"></span> Memuat…</div>';
  const data = await api(`/api/gaps/${type}?id=${id}`);
  state.lastGap = { scope_type: type, scope_ref: id, scope_label: type === 'employee' ? label.split(' — ')[0] : label };
  state.lastAiMarkdown = ''; state.lastQuizTopics = null;

  const topics = data.topics || [];
  const gapCount = (data.gaps || []).length;
  // Per karyawan, skor topik = nilai terbaik; per divisi = rata-rata nilai terbaik.
  const scoreHead = type === 'employee' ? 'Skor Terbaik' : 'Skor Rata-rata';
  const rows = topics.map((t) => `
    <tr>
      <td>${esc(t.topic)}</td>
      <td><span class="muted">${esc(t.area || '-')}</span></td>
      <td><span class="pill ${scoreClass(t.avg_score)}">${t.avg_score}/100</span></td>
      <td>${t.attempts}</td>
      <td>${t.avg_score < data.gapThreshold ? '<span class="pill bad">GAP</span>' : '<span class="pill good">OK</span>'}</td>
    </tr>`).join('');

  box.innerHTML = `
    <div class="panel">
      <div class="page-head" style="margin:0 0 6px">
        <div><h3 style="margin:0">${esc(state.lastGap.scope_label)}</h3>
          <div class="kv"><span>Skor keseluruhan: <strong style="color:${scoreColor(data.overall)}">${data.overall}/100</strong></span>
          <span>Gap terdeteksi: <strong>${gapCount}</strong></span>
          <span>Ambang gap: &lt; ${data.gapThreshold}</span></div>
        </div>
      </div>
      <div class="scroll-x"><table>
        <thead><tr><th>Topik</th><th>Area</th><th>${scoreHead}</th><th>Attempts</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="row" style="margin-top:14px">
        <button class="btn sm" id="btnAiRec">🧠 AI Recommendation</button>
        <button class="btn sm ghost" id="btnQuizRec">📚 Rekomendasi Topik Kuis</button>
      </div>
      <div id="aiRecBox"></div>
      <div id="quizRecBox"></div>
    </div>`;
  $('#btnAiRec').addEventListener('click', runAiRecommendation);
  $('#btnQuizRec').addEventListener('click', runQuizTopics);
}

// Feature 1
async function runAiRecommendation() {
  const btn = $('#btnAiRec'); const box = $('#aiRecBox');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Menganalisis…';
  box.innerHTML = '';
  try {
    const out = await api('/api/ai/recommendation', { method: 'POST', body: JSON.stringify(state.lastGap) });
    state.lastAiMarkdown = out.markdown;
    box.innerHTML = `
      <div class="panel" style="margin-top:14px">
        <h3>🧠 AI Recommendation <span class="pill muted">${esc(out.model || state.config.model)}</span></h3>
        <div class="md">${md(out.markdown)}</div>
        ${canSubmit() ? '<div class="row" style="margin-top:12px"><button class="btn sm" id="btnSubmitRec">📤 Kirim ke Direktur untuk Acknowledge</button></div><div id="submitMsg"></div>' : ''}
      </div>`;
    if (canSubmit()) $('#btnSubmitRec').addEventListener('click', () => submitRecommendation('ai'));
  } catch (e) {
    box.innerHTML = `<div class="notice err">Gagal: ${esc(e.message)}</div>`;
  } finally { btn.disabled = false; btn.innerHTML = '🧠 AI Recommendation'; }
}

// Feature 2
async function runQuizTopics() {
  const btn = $('#btnQuizRec'); const box = $('#quizRecBox');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Menyusun…';
  box.innerHTML = '';
  try {
    const out = await api('/api/ai/quiz-topics', { method: 'POST', body: JSON.stringify(state.lastGap) });
    state.lastQuizTopics = out.recommended_quizzes || [];
    const cards = (out.recommended_quizzes || []).map((q) => {
      const pr = q.priority || 'Sedang';
      const prClass = /tinggi/i.test(pr) ? 'bad' : /sedang/i.test(pr) ? 'warn' : 'info';
      const subs = (q.suggested_subtopics || []).map((s) => `<span class="pill muted" style="margin:2px">${esc(s)}</span>`).join(' ');
      return `<div class="card" style="margin-top:10px">
        <div class="row" style="justify-content:space-between">
          <strong>${esc(q.topic)}</strong>
          <span class="pill ${prClass}">Prioritas ${esc(pr)}</span>
        </div>
        <div class="muted" style="margin:6px 0">${esc(q.reason || '')}</div>
        <div>${subs}</div>
        ${q.target_score ? `<div class="kv"><span>Target skor: <strong>${esc(q.target_score)}/100</strong></span></div>` : ''}
      </div>`;
    }).join('');
    box.innerHTML = `
      <div class="panel" style="margin-top:14px">
        <h3>📚 Rekomendasi Topik Kuis <span class="pill muted">${esc(out.model || state.config.model)}</span></h3>
        <p class="muted">${esc(out.summary || '')}</p>
        ${cards || '<div class="muted">Tidak ada rekomendasi.</div>'}
      </div>`;
  } catch (e) {
    box.innerHTML = `<div class="notice err">Gagal: ${esc(e.message)}</div>`;
  } finally { btn.disabled = false; btn.innerHTML = '📚 Rekomendasi Topik Kuis'; }
}

function canSubmit() { return state.role === 'super_admin' || state.role === 'auditor'; }

async function submitRecommendation() {
  const msg = $('#submitMsg');
  const body = {
    scope_type: state.lastGap.scope_type,
    scope_ref: state.lastGap.scope_ref,
    scope_label: state.lastGap.scope_label,
    title: `Rekomendasi gap — ${state.lastGap.scope_label}`,
    recommendation: state.lastAiMarkdown,
    recommended_topics: (state.lastQuizTopics || []).map((q) => q.topic),
    model: state.config.model,
  };
  try {
    await api('/api/recommendations', { method: 'POST', body: JSON.stringify(body) });
    msg.innerHTML = '<div class="notice ok">Terkirim ke Direktur. Lihat tab Acknowledgement.</div>';
  } catch (e) {
    msg.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Tren Skor per Waktu (SVG line chart, zero-dependency)
// ---------------------------------------------------------------------------
const MON_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
function monthLabel(ym) { const [y, m] = ym.split('-'); return `${MON_ID[(+m) - 1]} ${y.slice(2)}`; }

function trendChart(months, series, gapThreshold) {
  const W = 760, H = 300, padL = 40, padR = 18, padT = 16, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = months.length;
  const X = (i) => padL + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const Y = (v) => padT + plotH * (1 - v / 100);
  let g = '';
  for (let v = 0; v <= 100; v += 20) {
    const yy = Y(v);
    g += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#2a376b" stroke-width="1"/>`;
    g += `<text x="${padL - 8}" y="${yy + 4}" text-anchor="end" fill="#97a3c7" font-size="11">${v}</text>`;
  }
  const gy = Y(gapThreshold);
  g += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#f87171" stroke-width="1.5" stroke-dasharray="5 4"/>`;
  g += `<text x="${W - padR}" y="${gy - 5}" text-anchor="end" fill="#f87171" font-size="10.5">ambang gap ${gapThreshold}</text>`;
  months.forEach((m, i) => {
    g += `<text x="${X(i)}" y="${H - 12}" text-anchor="middle" fill="#97a3c7" font-size="11">${monthLabel(m)}</text>`;
  });
  series.forEach((s) => {
    const pts = months.map((m, i) => ({ i, v: s.map[m] })).filter((p) => p.v != null);
    if (!pts.length) return;
    const d = pts.map((p, k) => `${k ? 'L' : 'M'}${X(p.i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
    const dash = s.faint ? ' stroke-dasharray="4 4"' : '';
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.faint ? 2 : 2.6}"${dash} stroke-linejoin="round" stroke-linecap="round" opacity="${s.faint ? 0.65 : 1}"/>`;
    pts.forEach((p) => {
      g += `<circle cx="${X(p.i).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="${s.faint ? 2.5 : 3.6}" fill="${s.color}"><title>${esc(s.name)} · ${monthLabel(months[p.i])}: ${p.v}/100</title></circle>`;
    });
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" style="display:block">${g}</svg>`;
}

$('#trendMode').addEventListener('change', () => {
  const mode = $('#trendMode').value;
  const wrap = $('#trendPickWrap');
  const pick = $('#trendPick');
  if (mode === 'overall') { wrap.style.display = 'none'; loadTrend(); return; }
  const list = mode === 'division' ? divisions : topics;
  pick.innerHTML = list.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  wrap.style.display = '';
  loadTrend();
});
$('#trendPick').addEventListener('change', loadTrend);
$('#trendRange').addEventListener('change', loadTrend);

async function loadTrend() {
  const mode = $('#trendMode').value;
  const pickVal = $('#trendPick').value;
  const params = new URLSearchParams();
  if (mode === 'division' && pickVal) params.set('division', pickVal);
  else if (mode === 'topic' && pickVal) params.set('topic', pickVal);
  const range = $('#trendRange').value;
  if (range !== 'all') params.set('months', range);
  const url = '/api/trend' + (params.toString() ? `?${params}` : '');
  const box = $('#trendChart'); const legend = $('#trendLegend');
  box.innerHTML = '<span class="spinner"></span> Memuat…';
  try {
    const data = await api(url);
    const months = data.overall.map((r) => r.month);
    const overallMap = Object.fromEntries(data.overall.map((r) => [r.month, r.avg_score]));
    const series = [];
    if (data.filtered) {
      const fmap = Object.fromEntries(data.filtered.map((r) => [r.month, r.avg_score]));
      series.push({ name: data.label, color: '#7c5cff', map: fmap });
      series.push({ name: 'Keseluruhan', color: '#5b8cff', map: overallMap, faint: true });
    } else {
      series.push({ name: 'Keseluruhan', color: '#5b8cff', map: overallMap });
    }
    box.innerHTML = trendChart(months, series, data.gapThreshold);
    legend.innerHTML = series.map((s) =>
      `<span class="row" style="gap:6px"><span style="width:13px;height:13px;border-radius:3px;background:${s.color};display:inline-block;${s.faint ? 'opacity:.65' : ''}"></span><span class="muted">${esc(s.name)}</span></span>`
    ).join('&nbsp;&nbsp;');
  } catch (e) {
    box.innerHTML = `<div class="notice err">Gagal memuat tren: ${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Acknowledgement (Feature 3b)
// ---------------------------------------------------------------------------
async function loadAcks() {
  const box = $('#ackList'); if (!box) return;
  const recs = await api('/api/recommendations');
  if (!recs.length) {
    box.innerHTML = '<div class="panel muted">Belum ada rekomendasi. Super Admin/Auditor dapat mengirim dari tab Knowledge Gaps.</div>';
    return;
  }
  box.innerHTML = '';
  recs.forEach((r) => {
    const ackd = r.status === 'acknowledged';
    const topics = safeArr(r.recommended_topics);
    const card = el('div', 'panel');
    card.innerHTML = `
      <div class="page-head" style="margin:0 0 8px">
        <div><h3 style="margin:0">${esc(r.title)}</h3>
          <div class="kv"><span>Scope: <strong>${esc(r.scope_label || r.scope_type)}</strong></span>
            <span>Oleh: ${esc(r.created_by)}</span>
            <span>${new Date(r.created_at).toLocaleString('id-ID')}</span></div></div>
        <span class="pill ${ackd ? 'good' : 'warn'}">${ackd ? '✓ Acknowledged' : 'Menunggu Direktur'}</span>
      </div>
      ${topics.length ? `<div style="margin:6px 0">${topics.map((t) => `<span class="pill info" style="margin:2px">${esc(t)}</span>`).join(' ')}</div>` : ''}
      <details><summary class="muted" style="cursor:pointer">Lihat isi rekomendasi</summary>
        <div class="md" style="margin-top:8px">${md(r.recommendation || '-')}</div></details>
      <div class="ackArea" style="margin-top:12px"></div>`;
    const area = card.querySelector('.ackArea');
    if (ackd) {
      area.innerHTML = `<div class="notice ok">Di-acknowledge oleh <strong>${esc(r.ack_by)}</strong> · ${new Date(r.ack_at).toLocaleString('id-ID')}${r.ack_note ? `<br>Catatan: ${esc(r.ack_note)}` : ''}</div>`;
    } else if (state.role === 'director') {
      area.innerHTML = `
        <div class="row"><input type="text" placeholder="Catatan (opsional)" style="flex:1" />
          <button class="btn sm">✅ Acknowledge</button></div>`;
      const input = area.querySelector('input'); const btn = area.querySelector('button');
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
        try { await api(`/api/recommendations/${r.id}/acknowledge`, { method: 'POST', body: JSON.stringify({ ack_note: input.value }) }); loadAcks(); }
        catch (e) { btn.disabled = false; btn.textContent = '✅ Acknowledge'; alert(e.message); }
      });
    } else {
      area.innerHTML = '<span class="muted">Menunggu acknowledge dari Direktur.</span>';
    }
    box.appendChild(card);
  });
}
function safeArr(s) { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (_) { return []; } }

// ---------------------------------------------------------------------------
// Pengaturan
// ---------------------------------------------------------------------------
async function loadSettings() {
  if (state.role !== 'super_admin') return;
  try {
    const s = await api('/api/settings');
    const t = $('#tglPlanned'); if (t) t.checked = !!s.quizPlanned;
  } catch (_) {}
}

async function saveQuizSetting(key, value) {
  const msg = $('#settingsMsg');
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ [key]: value }) });
    msg.innerHTML = '<div class="notice ok">Tersimpan.</div>';
    setTimeout(() => { if (msg) msg.innerHTML = ''; }, 1500);
  } catch (e) { msg.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
}

(function initSettingsUI() {
  const t = $('#tglPlanned');
  if (t) t.addEventListener('change', () => saveQuizSetting('quizPlanned', t.checked));
})();

// ---------------------------------------------------------------------------
// Kuis Anda (Peserta Audit) — kurikulum lengkap: SEMUA topik, urutan tetap
// ---------------------------------------------------------------------------
async function loadNewQuiz() {
  const gapBox = $('#newQuizGapBox');
  if (!gapBox) return;
  // refreshes only the topic list; never clears the quiz/result area (#newQuizPlayBox)
  gapBox.innerHTML = '<div class="panel"><span class="spinner"></span> Memuat daftar topik kuis…</div>';
  try {
    const data = await api(`/api/participant/curriculum?id=${state.employeeId}`);
    const pass = state.config.gapThreshold; // ambang lulus (70)
    const rows = (data.topics || []).map((t, idx) => {
      const status = t.done
        ? (t.best_score < pass
            ? `<span class="pill bad">Failed · ${t.best_score}/100</span>`
            : `<span class="pill good">Passed · ${t.best_score}/100</span>`)
        : '<span class="pill warn">Belum dikerjakan</span>';
      const btn = t.done
        ? `<button class="btn sm ghost" data-topic="${t.topic_id}" data-name="${esc(t.topic)}">↻ Ulangi Kuis</button>`
        : `<button class="btn sm" data-topic="${t.topic_id}" data-name="${esc(t.topic)}">▶ Mulai Kuis</button>`;
      return `
        <tr>
          <td><span class="muted">${idx + 1}</span></td>
          <td>${esc(t.topic)}</td>
          <td><span class="muted">${esc(t.area || '-')}</span></td>
          <td>${status}</td>
          <td>${btn}</td>
        </tr>`;
    }).join('');
    gapBox.innerHTML = `
      <div class="panel">
        <div class="page-head" style="margin:0 0 6px"><div>
          <h3 style="margin:0">${esc(data.employee.name)} <span class="pill muted">${esc(data.employee.division)}</span></h3>
          <div class="kv">
            <span>Total topik: <strong>${data.totalTopics}</strong></span>
            <span>Sudah dikerjakan: <strong style="color:${scoreColor(80)}">${data.doneCount}</strong></span>
            <span>Belum dikerjakan: <strong style="color:var(--warn)">${data.undoneCount}</strong></span>
            <span>Soal per topik: <strong>${data.questionsPerTopic}</strong></span>
          </div>
        </div></div>
        <div class="muted" style="margin-bottom:8px">Setiap peserta — baru maupun yang sudah pernah — melewati seluruh <strong>${data.totalTopics} topik</strong> secara berurutan. Soal dibuat oleh ${esc(state.config.aiProvider || "AI")} (${data.questionsPerTopic} soal/topik) dan skor tercatat ke data.</div>
        <div class="scroll-x"><table>
          <thead><tr><th>#</th><th>Topik</th><th>Area</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`;
    gapBox.querySelectorAll('button[data-topic]').forEach((b) =>
      b.addEventListener('click', () => startQuiz(Number(b.dataset.topic), b.dataset.name,
        { playBox: $('#newQuizPlayBox'), reload: loadNewQuiz })));
  } catch (e) {
    gapBox.innerHTML = `<div class="notice err">Gagal memuat: ${esc(e.message)}</div>`;
  }
}

async function startQuiz(topicId, topicName, ctx) {
  const playBox = ctx.playBox;
  state.activeQuizCtx = ctx;
  playBox.innerHTML = `<div class="panel"><span class="spinner"></span> <strong>DeepSeek</strong> sedang merencanakan sub-konsep lalu menyusun soal untuk <strong>${esc(topicName)}</strong>…</div>`;
  playBox.scrollIntoView({ block: 'start' });
  try {
    const quiz = await api('/api/quiz/generate', {
      method: 'POST', body: JSON.stringify({ employee_id: state.employeeId, topic_id: topicId }),
    });
    state.activeQuiz = quiz;
    const items = quiz.questions.map((q) => `
      <div class="card" style="margin-top:10px" data-q="${q.i}">
        <div style="font-weight:600;margin-bottom:4px">${q.i + 1}. ${esc(q.question)}</div>
        ${q.subconcept ? `<div class="muted" style="margin-bottom:8px;font-size:12px">${esc(q.subconcept)}</div>` : ''}
        ${q.options.map((opt, oi) => `
          <label style="display:flex;gap:9px;align-items:flex-start;padding:6px 0;cursor:pointer">
            <input type="radio" name="q${q.i}" value="${oi}" style="margin-top:3px" />
            <span>${esc(opt)}</span>
          </label>`).join('')}
      </div>`).join('');
    playBox.innerHTML = `
      <div class="panel">
        <div class="page-head" style="margin:0 0 6px"><div>
          <h3 style="margin:0">Kuis: ${esc(quiz.topic)}
            <span class="pill muted">${esc(quiz.model || state.config.model)}</span>
            ${quiz.method === 'planned' ? '<span class="pill info">🧠 terencana</span>' : ''}
          </h3>
          <div class="kv"><span>${quiz.num_questions} soal · setiap soal bernilai ${Math.round(100 / quiz.num_questions)} poin · maks 100</span></div>
        </div></div>
        ${planTraceHtml(quiz)}
        ${items}
        <div class="row" style="margin-top:14px">
          <button class="btn" id="submitQuizBtn">📤 Kumpulkan Jawaban</button>
          <button class="btn ghost sm" id="cancelQuizBtn">Batal</button>
          <span id="quizValidateMsg" class="muted"></span>
        </div>
      </div>`;
    $('#cancelQuizBtn').addEventListener('click', () => { state.activeQuiz = null; playBox.innerHTML = ''; });
    $('#submitQuizBtn').addEventListener('click', submitQuiz);
  } catch (e) {
    playBox.innerHTML = `<div class="notice err">Gagal membuat kuis: ${esc(e.message)}</div>`;
  }
}

// Per-question source line: 📚 source badge (+ score) or 💡 general-knowledge,
// plus a collapsible "lihat kutipan sumber" expander showing the grounding excerpt.
// Jejak perencanaan sub-konsep untuk kuis yang dibuat dalam mode terencana.
function planTraceHtml(quiz) {
  const trace = quiz.trace || [];
  if (!trace.length) return '';
  const subs = trace.find((t) => t.step === 'subtopics');
  const thought = trace.find((t) => t.step === 'plan' && t.thought);
  if (!subs && !thought) return '';
  const items = subs && Array.isArray(subs.subtopics)
    ? subs.subtopics.map((x, i) => `<li>${i + 1}. ${esc(x)}</li>`).join('')
    : '';
  return `
    <details style="margin:4px 0 10px">
      <summary class="muted" style="cursor:pointer">🧠 Rencana sub-konsep${subs && subs.subtopics ? ` (${subs.subtopics.length})` : ''}</summary>
      ${thought ? `<div class="muted" style="margin:8px 0">💭 ${esc(thought.thought)}</div>` : ''}
      ${items ? `<ul style="margin:6px 0 0 4px;list-style:none;padding:0">${items}</ul>` : ''}
    </details>`;
}

async function submitQuiz() {
  const quiz = state.activeQuiz; if (!quiz) return;
  const ctx = state.activeQuizCtx || { playBox: $('#newQuizPlayBox'), reload: loadNewQuiz };
  const answers = [];
  let unanswered = 0;
  quiz.questions.forEach((q) => {
    const sel = document.querySelector(`input[name="q${q.i}"]:checked`);
    if (sel) answers[q.i] = Number(sel.value); else { answers[q.i] = null; unanswered++; }
  });
  if (unanswered > 0) {
    $('#quizValidateMsg').innerHTML = `<span style="color:var(--bad)">Masih ada ${unanswered} soal belum dijawab.</span>`;
    return;
  }
  const btn = $('#submitQuizBtn'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Menilai…';
  try {
    const out = await api('/api/quiz/submit', {
      method: 'POST', body: JSON.stringify({ session_id: quiz.session_id, answers }),
    });
    const prevTxt = out.prevBest == null ? '–' : `${out.prevBest}`;
    const bestPill = out.improved
      ? (out.prevBest == null
          ? '<span class="pill good">Tersimpan</span>'
          : `<span class="pill good">▲ +${out.newBest - out.prevBest}</span>`)
      : '<span class="pill muted">Tetap</span>';
    const saveNotice = !out.improved
      ? `<div class="notice">Skor kuis ini (<strong>${out.score}/100</strong>) tidak melampaui skor terbaik lama (<strong>${out.prevBest}/100</strong>). Skor lama dipertahankan.</div>`
      : out.prevBest == null
        ? `<div class="notice ok">Skor pertama untuk topik ini tersimpan: <strong>${out.newBest}/100</strong>.</div>`
        : `<div class="notice ok">Skor baru lebih tinggi — skor terbaik topik diperbarui menjadi <strong>${out.newBest}/100</strong> dan tersimpan.</div>`;
    const feedback = out.results.map((r) => `
      <div class="card" style="margin-top:8px;border-color:${r.ok ? 'rgba(52,211,153,.4)' : 'rgba(248,113,113,.4)'}">
        <div style="font-weight:600">${r.i + 1}. ${esc(r.question)} <span class="pill ${r.ok ? 'good' : 'bad'}">${r.ok ? 'Benar' : 'Salah'}</span></div>
        <div style="margin-top:6px">${r.options.map((opt, oi) => {
          const isAns = oi === r.answer_index; const isChosen = oi === r.chosen;
          const mark = isAns ? '✅' : (isChosen ? '❌' : '·');
          const col = isAns ? 'var(--good)' : (isChosen ? 'var(--bad)' : 'var(--muted)');
          return `<div style="color:${col}">${mark} ${esc(opt)}</div>`;
        }).join('')}</div>
        ${r.explanation ? `<div class="muted" style="margin-top:6px">💡 ${esc(r.explanation)}</div>` : ''}
      </div>`).join('');
    ctx.playBox.innerHTML = `
      <div class="panel">
        <div class="page-head" style="margin:0 0 8px"><div>
          <h3 style="margin:0">Hasil Kuis: ${esc(out.topic)}</h3>
          <div class="kv">
            <span>Skor: <strong style="color:${scoreColor(out.score)};font-size:18px">${out.score}/100</strong></span>
            <span>Benar ${out.correct} dari ${out.total}</span>
            <span>Skor terbaik topik: ${prevTxt} → <strong style="color:${scoreColor(out.newBest)}">${out.newBest}/100</strong> ${bestPill}</span>
          </div>
        </div></div>
        ${saveNotice}
        <div style="margin-top:10px">${feedback}</div>
        <div class="row" style="margin-top:14px"><button class="btn sm" id="backToGaps">↺ Kembali ke daftar topik</button></div>
      </div>`;
    state.activeQuiz = null;
    $('#backToGaps').addEventListener('click', ctx.reload);
    ctx.reload(); // refresh the topic list (the just-finished topic moves out of "belum dikerjakan")
  } catch (e) {
    btn.disabled = false; btn.innerHTML = '📤 Kumpulkan Jawaban';
    $('#quizValidateMsg').innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`;
  }
}

// ---------------------------------------------------------------------------
// Boot: lanjutkan sesi yang masih berlaku, atau tampilkan layar masuk
// ---------------------------------------------------------------------------
(async function boot() {
  try {
    const { user } = await api('/api/auth/me');
    await enterApp(user);
  } catch (_) {
    showAuth();
  }
})();
