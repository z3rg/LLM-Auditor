'use strict';
// ---------------------------------------------------------------------------
// LLM Auditor — frontend
// ---------------------------------------------------------------------------
const state = {
  role: null,
  config: { model: 'groq', gapThreshold: 70 },
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

function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.role) headers['x-role'] = state.role;
  return fetch(path, { ...opts, headers }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  });
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
// Login
// ---------------------------------------------------------------------------
let pickedRole = null;
$$('.role-opt').forEach((opt) => opt.addEventListener('click', async () => {
  $$('.role-opt').forEach((o) => o.classList.remove('active'));
  opt.classList.add('active');
  pickedRole = opt.dataset.role;
  const isParticipant = pickedRole === 'participant';
  $('#participantPickWrap').classList.toggle('hidden', !isParticipant);
  if (isParticipant) {
    $('#loginBtn').disabled = !$('#participantPick').value;
    if ($('#participantPick').options.length <= 1) {
      try {
        const list = await api('/api/employees');
        $('#participantPick').innerHTML =
          '<option value="">— pilih nama —</option>' +
          list.map((e) => `<option value="${e.id}">${esc(e.name)} — ${esc(e.division)}</option>`).join('');
      } catch (_) {}
    }
  } else {
    $('#loginBtn').disabled = false;
  }
}));
$('#participantPick').addEventListener('change', () => {
  if (pickedRole === 'participant') $('#loginBtn').disabled = !$('#participantPick').value;
});
$('#loginBtn').addEventListener('click', () => {
  if (pickedRole === 'participant') {
    const sel = $('#participantPick');
    if (!sel.value) return;
    state.employeeId = Number(sel.value);
    state.employeeName = sel.selectedOptions[0].textContent.split(' — ')[0];
  }
  enterApp(pickedRole);
});
$('#logoutBtn').addEventListener('click', () => location.reload());

async function enterApp(role) {
  state.role = role;
  try { state.config = await api('/api/config'); } catch (_) {}
  const meta = ROLE_META[role];
  $('#roleIcon').textContent = meta.icon;
  $('#roleName').textContent = role === 'participant' ? state.employeeName : meta.name;
  $('#modelName').textContent = role === 'participant' ? meta.name : (state.config.model || 'groq');
  // generic role-gated nav: show items whose data-roles includes this role
  let firstTab = null;
  $$('.nav-item[data-tab]').forEach((n) => {
    const allowed = (n.dataset.roles || '').split(',').includes(role);
    n.style.display = allowed ? '' : 'none';
    n.classList.remove('active');
    if (allowed && !firstTab) firstTab = n;
  });
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  if (role === 'participant') {
    loadNewQuiz();
  } else {
    loadOverview();
    loadScopeOptions();
    loadAcks();
    buildSqlExamples();
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
}));

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
// SQL Agent
// ---------------------------------------------------------------------------
const SQL_EXAMPLES = [
  'Divisi mana dengan skor rata-rata terendah?',
  'Divisi dengan jumlah gap pengetahuan terbanyak',
  'Karyawan dengan gap pengetahuan terbanyak',
  'Topik dengan skor rata-rata terendah',
  'Apa saja gap pengetahuan di divisi IT?',
  'Tren skor rata-rata per bulan',
];
function buildSqlExamples() {
  const box = $('#sqlExamples'); if (!box) return;
  box.innerHTML = '<span class="muted">Contoh:</span> ';
  SQL_EXAMPLES.forEach((q) => {
    const b = el('button', 'btn ghost sm', esc(q));
    b.addEventListener('click', () => { $('#sqlQuestion').value = q; askSql(); });
    box.appendChild(b);
  });
}
$('#askSql').addEventListener('click', askSql);
$('#sqlQuestion').addEventListener('keydown', (e) => { if (e.key === 'Enter') askSql(); });

// Round floats for display; pass through everything else.
function fmtCell(v) {
  if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 100) / 100;
  return v;
}

async function askSql() {
  const q = $('#sqlQuestion').value.trim();
  const box = $('#sqlResult');
  if (!q) return;
  box.innerHTML = '<div class="panel"><span class="spinner"></span> SQL Agent berpikir…</div>';
  try {
    const out = await api('/api/sql-agent', { method: 'POST', body: JSON.stringify({ question: q }) });
    let table = '<div class="notice">Query berhasil dijalankan, tetapi tidak ada baris yang cocok. Coba ubah/sederhanakan pertanyaan.</div>';
    if (out.runError) {
      table = `<div class="notice err">Eksekusi gagal: ${esc(out.runError)}</div>`;
    } else if (out.rows.length) {
      const head = out.columns.map((c) => `<th>${esc(c)}</th>`).join('');
      const body = out.rows.map((r) => `<tr>${out.columns.map((c) => `<td>${esc(fmtCell(r[c]))}</td>`).join('')}</tr>`).join('');
      table = `<div class="scroll-x"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    }
    box.innerHTML = `
      <div class="panel">
        <h3>Hasil <span class="pill muted">${esc(out.model || state.config.model)}</span> <span class="pill info">${out.rowCount} baris</span>${out.repaired ? ' <span class="pill warn">diperbaiki otomatis</span>' : ''}</h3>
        <p class="muted">${esc(out.explanation || '')}</p>
        <div class="codeblock">${esc(out.sql)}</div>
        <div style="margin-top:12px">${table}</div>
      </div>`;
  } catch (e) {
    box.innerHTML = `<div class="notice err">Gagal: ${esc(e.message)}</div>`;
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
// Pengaturan: PDF Importer (RAG) + toggle ReAct
// ---------------------------------------------------------------------------
async function loadSettings() {
  if (state.role !== 'super_admin') return;
  try {
    const s = await api('/api/settings');
    renderRagStatus(s.rag);
    $('#tglReact').checked = !!s.quizUseReact;
    $('#tglRag').checked = !!s.quizUseRag;
    const tl = $('#tglLegalMode'); if (tl) tl.checked = !!s.pdfLegalMode;
  } catch (_) {}
  loadPdfDocs();
  loadEmbedConfig();
}

function renderRagStatus(rag) {
  const box = $('#ragStatus'); if (!box || !rag) return;
  const backend = rag.vecEnabled
    ? '<span class="pill good">sqlite-vec aktif</span>'
    : '<span class="pill warn">fallback cosine JS</span>';
  const emb = rag.embedderKind === 'model'
    ? `<span class="pill good">${esc(rag.embedder)}</span>`
    : `<span class="pill warn">${esc(rag.embedder || '–')}</span>`;
  box.innerHTML = `
    <span>Embedding model: ${emb}</span>
    <span>Vector store: ${backend}</span>
    <span>Dokumen: <strong>${rag.documents}</strong></span>
    <span>Potongan (chunk): <strong>${rag.chunks}</strong></span>
    <span>Dimensi: <strong>${rag.dim ?? '–'}</strong></span>`;
}

async function loadPdfDocs() {
  const box = $('#pdfDocs'); if (!box) return;
  try {
    const data = await api('/api/pdf/documents');
    renderRagStatus(data.rag);
    if (!data.documents.length) {
      box.innerHTML = '<div class="muted">Belum ada PDF yang diimpor. Unggah PDF untuk menambah pengetahuan soal kuis.</div>';
      return;
    }
    const rows = data.documents.map((d) => `
      <tr>
        <td>${esc(d.title || d.filename)}</td>
        <td><span class="muted">${d.num_pages || '–'}</span></td>
        <td>${d.num_chunks}</td>
        <td><span class="muted">${fmtBytes(d.bytes)}</span></td>
        <td><span class="muted">${new Date(d.created_at).toLocaleString('id-ID')}</span></td>
        <td><button class="btn ghost sm" data-del="${d.id}">🗑 Hapus</button></td>
      </tr>`).join('');
    box.innerHTML = `
      <div class="scroll-x"><table>
        <thead><tr><th>Judul</th><th>Hal</th><th>Chunk</th><th>Ukuran</th><th>Diunggah</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
    box.querySelectorAll('button[data-del]').forEach((b) =>
      b.addEventListener('click', () => deletePdf(Number(b.dataset.del))));
  } catch (e) {
    box.innerHTML = `<div class="notice err">Gagal memuat dokumen: ${esc(e.message)}</div>`;
  }
}
function fmtBytes(n) {
  if (!n) return '–';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

async function deletePdf(id) {
  if (!confirm('Hapus dokumen ini dari basis pengetahuan?')) return;
  try { await api(`/api/pdf/documents/${id}`, { method: 'DELETE' }); loadPdfDocs(); }
  catch (e) { alert(e.message); }
}

async function uploadPdfFiles(files) {
  const msg = $('#pdfImportMsg');
  const list = [...files].filter((f) => /pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!list.length) { msg.innerHTML = '<div class="notice err">Pilih berkas PDF.</div>'; return; }
  for (const file of list) {
    msg.innerHTML = `<div class="notice"><span class="spinner"></span> Mengimpor <strong>${esc(file.name)}</strong>…</div>`;
    try {
      const buf = await file.arrayBuffer();
      const r = await fetch('/api/pdf/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf', 'x-role': state.role, 'x-filename': encodeURIComponent(file.name) },
        body: buf,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const d = data.document;
      msg.innerHTML = `<div class="notice ok">✓ <strong>${esc(d.title)}</strong> diimpor — ${d.num_chunks} chunk dari ${d.chars.toLocaleString('id-ID')} karakter.</div>`;
      renderRagStatus(data.rag);
    } catch (e) {
      msg.innerHTML = `<div class="notice err">Gagal mengimpor ${esc(file.name)}: ${esc(e.message)}</div>`;
    }
  }
  loadPdfDocs();
}

async function ragSearch() {
  const q = $('#ragQuery').value.trim();
  const box = $('#ragSearchResult');
  if (!q) return;
  box.innerHTML = '<div class="notice"><span class="spinner"></span> Mencari…</div>';
  try {
    const data = await api('/api/pdf/search', { method: 'POST', body: JSON.stringify({ query: q }) });
    if (!data.results.length) { box.innerHTML = '<div class="notice">Tidak ada hasil. Impor PDF terlebih dulu atau ubah kata kunci.</div>'; return; }
    box.innerHTML = data.results.map((r, i) => `
      <div class="card" style="margin-top:8px">
        <div class="row" style="justify-content:space-between">
          <strong>#${i + 1} · ${esc(r.source)}</strong>
          <span class="pill info">skor ${r.similarity}</span>
        </div>
        <div class="muted" style="margin-top:6px;white-space:pre-wrap">${esc(r.content.slice(0, 360))}…</div>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Embedding backend config
// ---------------------------------------------------------------------------
async function loadEmbedConfig() {
  try {
    const data = await api('/api/settings/embed');
    const mi = $('#geminiModelInput');
    if (mi && data.geminiModel) mi.value = data.geminiModel;
    const ki = $('#geminiKeyInput');
    if (ki && data.hasGeminiKey) ki.placeholder = '●●●●●●●● (sudah disetel — kosongkan untuk tidak mengubah)';
    const tl = $('#tglLegalMode'); if (tl) tl.checked = data.legalMode !== false;
    renderEmbedStatus(data.current);
  } catch (_) {}
}

function renderEmbedStatus(current) {
  const box = $('#embedStatus'); if (!box) return;
  if (!current) { box.innerHTML = '<span class="muted">Belum diinisialisasi.</span>'; return; }
  const kind = current.kind === 'model' ? 'good' : 'warn';
  box.innerHTML = `
    <span>Backend aktif: <span class="pill ${kind}">${esc(current.name)}</span></span>
    <span>Dimensi vektor: <strong>${current.dim}</strong></span>`;
}

async function applyEmbedConfig() {
  const msg = $('#embedMsg');
  const geminiKey  = (($('#geminiKeyInput') || {}).value || '').trim();
  const geminiModel = (($('#geminiModelInput') || {}).value || '').trim();
  const legalMode  = !!(($('#tglLegalMode') || {}).checked);
  if (msg) msg.innerHTML = '<div class="notice"><span class="spinner"></span> Menerapkan konfigurasi embedding…</div>';
  try {
    const body = { legalMode };
    if (geminiKey) body.geminiKey = geminiKey;
    if (geminiModel) body.geminiModel = geminiModel;
    const data = await api('/api/settings/embed', { method: 'POST', body: JSON.stringify(body) });
    renderEmbedStatus(data.current);
    renderRagStatus(data.rag);
    const name = data.current ? data.current.name : 'gemini';
    if (msg) msg.innerHTML = `<div class="notice ok">✓ Backend <strong>${esc(name)}</strong> aktif. Reindex berjalan di background.</div>`;
    const ki = $('#geminiKeyInput');
    if (ki && geminiKey) { ki.value = ''; ki.placeholder = '●●●●●●●● (sudah disetel — kosongkan untuk tidak mengubah)'; }
    setTimeout(() => { const m = $('#embedMsg'); if (m) m.innerHTML = ''; }, 4000);
  } catch (e) {
    if (msg) msg.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
  }
}

async function saveQuizSetting(key, value) {
  const msg = $('#settingsMsg');
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ [key]: value }) });
    msg.innerHTML = '<div class="notice ok">Tersimpan.</div>';
    setTimeout(() => { if (msg) msg.innerHTML = ''; }, 1500);
  } catch (e) { msg.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
}

// Wire up Settings controls (elements exist statically in index.html).
(function initSettingsUI() {
  const drop = $('#pdfDrop'), input = $('#pdfInput');
  if (drop && input) {
    drop.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { if (input.files.length) uploadPdfFiles(input.files); input.value = ''; });
    ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) uploadPdfFiles(e.dataTransfer.files); });
  }
  const sbtn = $('#ragSearchBtn'); if (sbtn) sbtn.addEventListener('click', ragSearch);
  const rq = $('#ragQuery'); if (rq) rq.addEventListener('keydown', (e) => { if (e.key === 'Enter') ragSearch(); });
  const tr = $('#tglReact'); if (tr) tr.addEventListener('change', () => saveQuizSetting('quizUseReact', tr.checked));
  const tg = $('#tglRag'); if (tg) tg.addEventListener('change', () => saveQuizSetting('quizUseRag', tg.checked));
  const tl = $('#tglLegalMode'); if (tl) tl.addEventListener('change', () => saveQuizSetting('pdfLegalMode', tl.checked));
  const ab = $('#applyEmbedBtn'); if (ab) ab.addEventListener('click', applyEmbedConfig);
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
        <div class="muted" style="margin-bottom:8px">Setiap peserta — baru maupun yang sudah pernah — melewati seluruh <strong>${data.totalTopics} topik</strong> secara berurutan. Soal dibuat oleh Groq (${data.questionsPerTopic} soal/topik) dan skor tercatat ke data.</div>
        <div class="scroll-x"><table>
          <thead><tr><th>#</th><th>Topik</th><th>Area</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <details style="margin-top:12px"><summary class="muted" style="cursor:pointer">Lihat query SQL daftar topik</summary>
          <div class="codeblock" style="margin-top:8px">${esc(data.sql)}</div></details>
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
  playBox.innerHTML = `<div class="panel"><span class="spinner"></span> Agen <strong>ReAct + RAG</strong> sedang menalar sub-konsep, menarik materi per soal dari basis pengetahuan, lalu menyusun soal untuk <strong>${esc(topicName)}</strong>…</div>`;
  playBox.scrollIntoView({ block: 'start' });
  try {
    const quiz = await api('/api/quiz/generate', {
      method: 'POST', body: JSON.stringify({ employee_id: state.employeeId, topic_id: topicId }),
    });
    state.activeQuiz = quiz;
    const items = quiz.questions.map((q) => `
      <div class="card" style="margin-top:10px" data-q="${q.i}">
        <div style="font-weight:600;margin-bottom:4px">${q.i + 1}. ${esc(q.question)}</div>
        <div style="margin-bottom:8px">${sourceLineHtml(q)}</div>
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
            ${quiz.method === 'ReAct' ? '<span class="pill info">🧠 ReAct</span>' : ''}
            ${quiz.groundedCount ? `<span class="pill good">📚 ${quiz.groundedCount}/${quiz.num_questions} soal berbasis PDF</span>` : ''}
          </h3>
          <div class="kv"><span>${quiz.num_questions} soal · setiap soal bernilai ${Math.round(100 / quiz.num_questions)} poin · maks 100</span>${
            quiz.method === 'ReAct' && typeof quiz.groundedCount === 'number'
              ? `<span>RAG: ${quiz.groundedCount} soal di-grounding ke materi PDF, ${quiz.num_questions - quiz.groundedCount} dari pengetahuan umum (di-blend)</span>`
              : ''}</div>
        </div></div>
        ${reactTraceHtml(quiz)}
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
function sourceLineHtml(q) {
  const badge = q.grounded
    ? `<span class="pill good" style="font-size:11px">📚 ${esc(q.source || 'PDF')}${q.similarity != null ? ` · skor ${q.similarity}` : ''}</span>`
    : `<span class="pill muted" style="font-size:11px">💡 pengetahuan umum</span>`;
  const excerpt = (q.grounded && q.excerpt)
    ? `<details class="src-excerpt" style="margin-top:6px">
         <summary>🔎 Lihat kutipan sumber${q.source ? ` · ${esc(q.source)}` : ''}</summary>
         <div class="quote">${esc(q.excerpt)}</div>
       </details>`
    : '';
  return `${badge}${excerpt}`;
}

// Collapsible ReAct reasoning trace + PDF sources for a generated quiz.
function reactTraceHtml(quiz) {
  const trace = quiz.trace || [];
  const sources = quiz.sources || [];
  if (!trace.length && !sources.length) return '';
  const ACT = { search_knowledge: '🔎 search_knowledge', generate_quiz: '✅ generate_quiz', final_answer: '🏁 final_answer' };
  const steps = trace.map((t, i) => `
    <div class="trace-step">
      <div class="act">Langkah ${i + 1} · ${esc(ACT[t.action] || t.action)}${t.action_input ? ` <span class="muted">(${esc(String(t.action_input).slice(0, 80))})</span>` : ''}</div>
      ${t.thought ? `<div><span class="muted">💭 Thought:</span> ${esc(t.thought)}</div>` : ''}
      ${t.observation ? `<div class="obs">👁 Observation:\n${esc(t.observation)}</div>` : ''}
    </div>`).join('');
  const srcPills = sources.map((s) => `<span class="pill muted" style="margin:2px">${esc(s.source)} · ${s.chunks} chunk</span>`).join(' ');
  return `
    <details style="margin:4px 0 10px">
      <summary class="muted" style="cursor:pointer">🧠 Jejak penalaran ReAct (${trace.length} langkah)${sources.length ? ` · sumber: ${sources.length} dokumen` : ''}</summary>
      ${sources.length ? `<div style="margin:8px 0">${srcPills}</div>` : ''}
      <div class="trace">${steps}</div>
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
        <div style="margin-top:6px">${sourceLineHtml(r)}</div>
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
