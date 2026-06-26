/** dashboard.ts — pagina HTML della GUI (servita da server.ts). */

export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Plaud Poller</title>
<style>
  :root {
    --bg:#0f1419; --panel:#171d26; --panel2:#1f2733; --border:#2a3441;
    --text:#e6edf3; --muted:#8b97a6; --accent:#4f9cf9; --ok:#3fb950;
    --warn:#d29922; --err:#f85149; --radius:10px;
  }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background:var(--bg); color:var(--text); }
  header { display:flex; align-items:center; gap:16px; padding:16px 24px;
    border-bottom:1px solid var(--border); background:var(--panel); position:sticky; top:0; z-index:10; }
  header h1 { font-size:17px; margin:0; font-weight:600; }
  .badges { display:flex; gap:8px; flex:1; flex-wrap:wrap; }
  .badge { font-size:12px; padding:3px 10px; border-radius:999px; background:var(--panel2);
    border:1px solid var(--border); color:var(--muted); }
  .badge.live { color:var(--ok); border-color:#1f4029; }
  .badge.run { color:var(--warn); border-color:#4a3a14; }
  .badge.err { color:var(--err); border-color:#4a1f1d; }
  button { font:inherit; cursor:pointer; border:1px solid var(--border); background:var(--panel2);
    color:var(--text); padding:8px 16px; border-radius:8px; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#06121f; font-weight:600; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  main { max-width:1100px; margin:0 auto; padding:24px; display:grid; gap:20px; }
  .grid { display:grid; gap:20px; grid-template-columns:1fr 1fr; }
  @media (max-width:820px){ .grid { grid-template-columns:1fr; } }
  .panel { background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); padding:18px; }
  .panel h2 { margin:0 0 14px; font-size:14px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }
  .stat { background:var(--panel2); border-radius:8px; padding:12px; text-align:center; }
  .stat .n { font-size:24px; font-weight:700; }
  .stat .l { font-size:11px; color:var(--muted); text-transform:uppercase; }
  label { display:block; margin:10px 0 4px; font-size:12px; color:var(--muted); }
  input[type=text], input[type=number], select { width:100%; padding:8px 10px; border-radius:8px;
    border:1px solid var(--border); background:var(--bg); color:var(--text); font:inherit; }
  .row { display:flex; align-items:center; gap:8px; margin:10px 0; }
  .row label { margin:0; color:var(--text); font-size:14px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  td.mono { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; }
  .pill { font-size:11px; padding:2px 8px; border-radius:999px; }
  .pill.yes { background:#16331f; color:var(--ok); }
  .pill.no { background:#3a2a14; color:var(--warn); }
  pre#logs { background:#0a0e13; border:1px solid var(--border); border-radius:8px; padding:12px;
    height:340px; overflow:auto; margin:0; font-family:ui-monospace,Menlo,Consolas,monospace;
    font-size:12px; white-space:pre-wrap; color:#c9d4e0; }
  .muted { color:var(--muted); }
  .save-row { margin-top:14px; display:flex; gap:10px; align-items:center; }
  .saved { color:var(--ok); font-size:13px; opacity:0; transition:opacity .3s; }
  .saved.show { opacity:1; }
</style>
</head>
<body>
<header>
  <h1>🎙️ Plaud Poller</h1>
  <div class="badges" id="badges"></div>
  <button class="primary" id="runBtn" onclick="runNow()">Esegui ora</button>
</header>
<main>
  <div class="panel">
    <h2>Stato</h2>
    <div class="stats" id="stats"></div>
  </div>

  <div class="grid">
    <div class="panel">
      <h2>Impostazioni</h2>
      <form id="settingsForm" onsubmit="saveSettings(event)">
        <label>Cartella output (NFS)</label>
        <input type="text" name="outputDir" />
        <div class="grid" style="gap:12px">
          <div>
            <label>Region</label>
            <select name="region"><option value="eu">eu</option><option value="us">us</option></select>
          </div>
          <div>
            <label>Formato audio</label>
            <select name="audioFormat"><option value="mp3">mp3</option><option value="original">original</option></select>
          </div>
        </div>
        <label>Intervallo polling (minuti)</label>
        <input type="number" name="pollIntervalMin" min="1" max="1440" />
        <div class="row"><input type="checkbox" id="includeTrash" name="includeTrash" /><label for="includeTrash">Includi cestino</label></div>

        <h2 style="margin-top:18px">Webhook (n8n)</h2>
        <div class="row"><input type="checkbox" id="whEnabled" name="webhook.enabled" /><label for="whEnabled">Abilita invio webhook</label></div>
        <label>URL webhook</label>
        <input type="text" name="webhook.url" placeholder="https://n8n.tuodominio/webhook/plaud" />
        <label>Modalità</label>
        <select name="webhook.mode"><option value="metadata">metadata (JSON con path NFS)</option><option value="multipart">multipart (futuro)</option></select>

        <div class="save-row">
          <button class="primary" type="submit">Salva impostazioni</button>
          <span class="saved" id="saved">✓ salvato</span>
        </div>
      </form>
    </div>

    <div class="panel">
      <h2>Log</h2>
      <pre id="logs">…</pre>
    </div>
  </div>

  <div class="panel">
    <h2>Registrazioni tracciate</h2>
    <table>
      <thead><tr><th>Data</th><th>Nome</th><th>Durata</th><th>Transcript</th><th>Notificata</th></tr></thead>
      <tbody id="recRows"></tbody>
    </table>
  </div>
</main>

<script>
const $ = (s) => document.querySelector(s);
function fmtDate(ms){ const d=new Date(ms<1e12?ms*1000:ms); return d.toLocaleString('it-IT',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function fmtDur(s){ const m=Math.floor(s/60), ss=s%60; return m+"m "+String(ss).padStart(2,'0')+"s"; }
function pill(v){ return v ? '<span class="pill yes">sì</span>' : '<span class="pill no">no</span>'; }

async function refreshStatus(){
  try {
    const s = await (await fetch('/api/status')).json();
    const b = [];
    b.push('<span class="badge '+(s.running?'run':'live')+'">'+(s.running?'⏳ in esecuzione':'● attivo')+'</span>');
    if(s.nextRunTs && !s.running){ const sec=Math.max(0,Math.round((s.nextRunTs-s.now)/1000)); b.push('<span class="badge">prossimo run: '+sec+'s</span>'); }
    if(s.tokenExpiry){ const days=Math.round((s.tokenExpiry-s.now)/86400000); b.push('<span class="badge'+(days<15?' err':'')+'">token: '+days+'g</span>'); }
    b.push('<span class="badge">webhook: '+(s.webhookEnabled?'ON':'OFF')+'</span>');
    if(s.lastError){ b.push('<span class="badge err">errore: '+s.lastError+'</span>'); }
    $('#badges').innerHTML = b.join('');
    $('#runBtn').disabled = s.running;
    const r = s.lastResult || {};
    $('#stats').innerHTML =
      stat(r.tracked ?? '–','tracciate')+stat(r.added ?? '–','ultime nuove')+
      stat(r.notified ?? '–','notificate')+stat(r.errors ?? '–','errori');
  } catch(e){ $('#badges').innerHTML='<span class="badge err">GUI offline</span>'; }
}
function stat(n,l){ return '<div class="stat"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'; }

async function refreshLogs(){
  try { const d = await (await fetch('/api/logs?lines=300')).json();
    const el=$('#logs'); const atBottom = el.scrollTop+el.clientHeight >= el.scrollHeight-20;
    el.textContent = d.lines.join('\\n'); if(atBottom) el.scrollTop=el.scrollHeight;
  } catch(e){}
}
async function refreshRecordings(){
  try { const list = await (await fetch('/api/recordings')).json();
    $('#recRows').innerHTML = list.map(r =>
      '<tr><td class="mono">'+fmtDate(r.startTime)+'</td><td>'+escapeHtml(r.filename)+
      '</td><td>'+fmtDur(r.durationSec)+'</td><td>'+pill(r.hasTranscript)+'</td><td>'+pill(r.notified)+'</td></tr>'
    ).join('') || '<tr><td colspan="5" class="muted">nessuna registrazione</td></tr>';
  } catch(e){}
}
function escapeHtml(s){ return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

async function loadSettings(){
  const s = await (await fetch('/api/settings')).json();
  const f = $('#settingsForm');
  f.outputDir.value = s.outputDir; f.region.value = s.region; f.audioFormat.value = s.audioFormat;
  f.pollIntervalMin.value = s.pollIntervalMin; f.includeTrash.checked = s.includeTrash;
  f['webhook.enabled'].checked = s.webhook.enabled; f['webhook.url'].value = s.webhook.url; f['webhook.mode'].value = s.webhook.mode;
}
async function saveSettings(e){
  e.preventDefault(); const f = e.target;
  const payload = {
    outputDir: f.outputDir.value, region: f.region.value, audioFormat: f.audioFormat.value,
    pollIntervalMin: Number(f.pollIntervalMin.value), includeTrash: f.includeTrash.checked,
    webhook: { enabled: f['webhook.enabled'].checked, url: f['webhook.url'].value, mode: f['webhook.mode'].value },
  };
  await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const s=$('#saved'); s.classList.add('show'); setTimeout(()=>s.classList.remove('show'),1500);
}
async function runNow(){ $('#runBtn').disabled=true; await fetch('/api/run',{method:'POST'}); setTimeout(refreshStatus,500); }

loadSettings(); refreshStatus(); refreshLogs(); refreshRecordings();
setInterval(refreshStatus,3000); setInterval(refreshLogs,3000); setInterval(refreshRecordings,10000);
</script>
</body>
</html>`;
