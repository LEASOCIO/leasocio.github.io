/* Journal de Dev HSE — PWA (client statique, API GitHub en direct) */
'use strict';

// ------------------------------- Config -----------------------------------
var LS = { token: 'gh_token', owner: 'gh_owner', repos: 'gh_repos', journal: 'gh_journal' };
var DEFAULT_OWNER = 'leasocio';
var DEFAULT_REPOS = 'S,BD,todolist,ACC,MCR,SP,FO,VS,5S,EKIP';
var DEFAULT_JOURNAL = 'todolist';
var BACKLOG_PATH = 'journal/backlog.json';
var GH = 'https://api.github.com';

function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

function getCfg() {
  return {
    token: lsGet(LS.token, ''),
    owner: lsGet(LS.owner, DEFAULT_OWNER),
    repos: lsGet(LS.repos, DEFAULT_REPOS).split(',').map(function (r) { return r.trim(); }).filter(Boolean),
    journalRepo: lsGet(LS.journal, DEFAULT_JOURNAL),
    today: new Date().toISOString().slice(0, 10)
  };
}
var CFG = getCfg();

// ------------------------------- Helpers ----------------------------------
function $(id) { return document.getElementById(id); }
function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function setStatus(id, html) { $(id).innerHTML = html; }
function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 3200); }

// base64 <-> UTF-8 (navigateur)
function b64encode(str) {
  var bytes = new TextEncoder().encode(str), bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decode(b64) {
  var bin = atob((b64 || '').replace(/\n/g, '')), bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

// ------------------------------- Client GitHub ----------------------------
function gh(method, path, body) {
  if (!CFG.token) return Promise.reject(new Error('Token GitHub non configuré (⚙️).'));
  var opts = {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + CFG.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  var url = path.indexOf('http') === 0 ? path : GH + path;
  return fetch(url, opts).then(function (r) {
    return r.text().then(function (t) {
      var json = null; try { json = t ? JSON.parse(t) : null; } catch (e) {}
      return { code: r.status, json: json };
    });
  });
}

function ghGetContent(repo, path, ref) {
  var q = ref ? ('?ref=' + encodeURIComponent(ref)) : '';
  return gh('GET', '/repos/' + CFG.owner + '/' + repo + '/contents/' + path + q).then(function (res) {
    if (res.code === 404) return null;
    if (res.code !== 200 || !res.json) throw new Error('Lecture ' + path + ' échouée (HTTP ' + res.code + ').');
    return { content: res.json.content ? b64decode(res.json.content) : '', sha: res.json.sha };
  });
}

function ghPutContent(repo, path, contentStr, message, sha, branch) {
  var payload = { message: message, content: b64encode(contentStr) };
  if (sha) payload.sha = sha;
  if (branch) payload.branch = branch;
  return gh('PUT', '/repos/' + CFG.owner + '/' + repo + '/contents/' + path, payload).then(function (res) {
    if (res.code !== 200 && res.code !== 201) {
      throw new Error('Écriture ' + path + ' (HTTP ' + res.code + ' : ' + ((res.json && res.json.message) || '') + ')');
    }
    return res.json;
  });
}

function ghListBranches(repo) {
  var out = [];
  function page(p) {
    return gh('GET', '/repos/' + CFG.owner + '/' + repo + '/branches?per_page=100&page=' + p).then(function (res) {
      if (res.code !== 200 || !res.json || !res.json.length) return out;
      res.json.forEach(function (b) { out.push(b.name); });
      return (res.json.length === 100 && p < 5) ? page(p + 1) : out;
    });
  }
  return page(1);
}

function ghListCommits(repo, branch, sinceISO, untilISO) {
  var p = '/repos/' + CFG.owner + '/' + repo + '/commits?sha=' + encodeURIComponent(branch) +
          '&since=' + sinceISO + '&until=' + untilISO + '&per_page=100';
  return gh('GET', p).then(function (res) { return (res.code === 200 && res.json && res.json.length) ? res.json : []; });
}

// ------------------------------- Backlog ----------------------------------
var BACKLOG = { version: 1, updated: '', actions: [] };
var BACKLOG_SHA = null;

function loadBacklog() {
  setStatus('backlogStatus', '<span class="spin"></span> Chargement du backlog…');
  ghGetContent(CFG.journalRepo, BACKLOG_PATH, null).then(function (file) {
    if (!file) { BACKLOG = { version: 1, updated: '', actions: [] }; BACKLOG_SHA = null; setStatus('backlogStatus', 'ℹ️ Aucun backlog : ajoutez une action puis enregistrez.'); renderBacklog(); return; }
    try { BACKLOG = JSON.parse(file.content); } catch (e) { BACKLOG = { version: 1, updated: '', actions: [] }; }
    if (!BACKLOG.actions) BACKLOG.actions = [];
    BACKLOG_SHA = file.sha;
    setStatus('backlogStatus', '');
    renderBacklog();
  }).catch(function (e) { setStatus('backlogStatus', '❌ ' + e.message); });
}

function renderBacklog() {
  var groups = { en_cours: [], a_faire: [], fait: [] };
  (BACKLOG.actions || []).forEach(function (a) { (groups[a.statut] || groups.a_faire).push(a); });
  var defs = [
    { key: 'en_cours', label: 'En cours', cls: 'wip' },
    { key: 'a_faire', label: 'À faire', cls: 'todo' },
    { key: 'fait', label: 'Fait', cls: 'fait' }
  ];
  var html = '';
  defs.forEach(function (d) {
    html += '<div class="col c-' + d.cls + '"><h2>' + d.label + ' <span class="pill ' + d.cls + '">' + groups[d.key].length + '</span></h2>';
    if (!groups[d.key].length) html += '<div class="empty">—</div>';
    groups[d.key].forEach(function (a) { html += cardHtml(a); });
    html += '</div>';
  });
  $('backlogCols').innerHTML = html;
}

function cardHtml(a) {
  var commits = (a.commits && a.commits.length) ? '<span title="commits liés">🔗 ' + a.commits.length + '</span>' : '';
  var next = a.statut === 'a_faire' ? 'en_cours' : (a.statut === 'en_cours' ? 'fait' : 'a_faire');
  var nextLbl = next === 'en_cours' ? '▶ Démarrer' : (next === 'fait' ? '✔ Terminer' : '↺ Rouvrir');
  return '<div class="card">'
    + '<div class="title">' + esc(a.titre) + '</div>'
    + '<div class="meta"><span class="repo-tag">' + esc(a.repo || '?') + '</span>'
    + (a.date_faite ? '<span>✅ ' + esc(a.date_faite) + '</span>' : '') + commits + '</div>'
    + (a.notes ? '<div class="notes">' + esc(a.notes) + '</div>' : '')
    + '<div class="card-actions">'
    + '<button class="mini" data-act="cycle" data-id="' + esc(a.id) + '" data-next="' + next + '">' + nextLbl + '</button>'
    + '<button class="mini" data-act="edit" data-id="' + esc(a.id) + '">✎ Éditer</button>'
    + '<button class="mini" data-act="del" data-id="' + esc(a.id) + '">🗑</button>'
    + '</div></div>';
}

function findAction(id) { return (BACKLOG.actions || []).filter(function (a) { return a.id === id; })[0]; }

function saveBacklog() {
  var branch = $('writeBranch').value.trim() || 'main';
  setStatus('backlogStatus', '<span class="spin"></span> Envoi vers GitHub…');
  BACKLOG.updated = new Date().toISOString();
  var pretty = JSON.stringify(BACKLOG, null, 2);
  ghPutContent(CFG.journalRepo, BACKLOG_PATH, pretty, 'Journal: mise à jour du backlog (' + CFG.today + ')', BACKLOG_SHA, branch)
    .then(function (r) {
      BACKLOG_SHA = r.content ? r.content.sha : BACKLOG_SHA;
      setStatus('backlogStatus', '✅ Backlog poussé sur <b>' + esc(branch) + '</b>.');
      toast('Backlog enregistré sur GitHub');
    }).catch(function (e) { setStatus('backlogStatus', '❌ ' + e.message); });
}

// ------------------------------- Action modal -----------------------------
function fillRepoSelect() {
  var sel = $('actRepo'); sel.innerHTML = '';
  CFG.repos.forEach(function (r) { sel.innerHTML += '<option value="' + esc(r) + '">' + esc(r) + '</option>'; });
}
function openActionModal(id) {
  $('actId').value = id || '';
  var a = id ? findAction(id) : null;
  $('actionModalTitle').textContent = id ? '✎ Modifier l\'action' : '＋ Nouvelle action';
  $('actTitre').value = a ? a.titre : '';
  $('actRepo').value = a ? a.repo : (CFG.repos[0] || '');
  $('actStatut').value = a ? a.statut : 'a_faire';
  $('actNotes').value = a ? (a.notes || '') : '';
  $('actionModal').classList.add('open');
}
function saveAction() {
  var id = $('actId').value, titre = $('actTitre').value.trim();
  if (!titre) { toast('Titre requis'); return; }
  var repo = $('actRepo').value, statut = $('actStatut').value, notes = $('actNotes').value.trim();
  if (id) {
    var a = findAction(id); a.titre = titre; a.repo = repo; a.statut = statut; a.notes = notes;
    if (statut === 'fait' && !a.date_faite) a.date_faite = CFG.today;
    if (statut !== 'fait') a.date_faite = '';
  } else {
    BACKLOG.actions.push({ id: 'a' + Date.now().toString(36), titre: titre, repo: repo, statut: statut, notes: notes,
      date_prevue: CFG.today, date_faite: statut === 'fait' ? CFG.today : '', commits: [] });
  }
  $('actionModal').classList.remove('open');
  renderBacklog();
  toast('Action enregistrée localement — pensez à « Enregistrer le backlog ».');
}

// ------------------------------- Commits (soir) ---------------------------
var COMMITS = [], DIFF_LOADED = {};

function loadCommits() {
  var date = $('soirDate').value;
  if (!date) { toast('Choisissez une date'); return; }
  var start = new Date(date + 'T00:00:00');
  var end = new Date(start.getTime() + 24 * 3600 * 1000);
  var sinceISO = start.toISOString(), untilISO = end.toISOString();
  setStatus('commitsStatus', '<span class="spin"></span> Récupération des commits (toutes branches)…');
  $('commitsWrap').innerHTML = ''; $('recapBlock').style.display = 'none';
  COMMITS = [];
  var errors = [];

  var chain = Promise.resolve();
  CFG.repos.forEach(function (repo) {
    chain = chain.then(function () {
      return ghListBranches(repo).then(function (branches) {
        var seen = {}, commits = [];
        var bChain = Promise.resolve();
        branches.forEach(function (branch) {
          bChain = bChain.then(function () {
            return ghListCommits(repo, branch, sinceISO, untilISO).then(function (list) {
              list.forEach(function (c) {
                if (seen[c.sha] !== undefined) { commits[seen[c.sha]].branches.push(branch); return; }
                seen[c.sha] = commits.length;
                var d = c.commit && c.commit.author ? c.commit.author.date : '';
                commits.push({
                  repo: repo, sha: c.sha, shortSha: c.sha.slice(0, 7),
                  message: (c.commit && c.commit.message ? c.commit.message.split('\n')[0] : ''),
                  author: (c.commit && c.commit.author ? c.commit.author.name : (c.author ? c.author.login : '')),
                  dateISO: d, heure: d ? new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '',
                  branches: [branch]
                });
              });
            });
          });
        });
        return bChain.then(function () { commits.forEach(function (c) { COMMITS.push(c); }); });
      }).catch(function (e) { errors.push(repo + ' : ' + e.message); });
    });
  });

  chain.then(function () {
    COMMITS.sort(function (a, b) { return (b.dateISO || '').localeCompare(a.dateISO || ''); });
    var err = errors.length ? ' · ⚠️ ' + errors.length + ' repo(s) en erreur' : '';
    setStatus('commitsStatus', COMMITS.length + ' commit(s) le ' + date + err);
    renderCommits();
  }).catch(function (e) { setStatus('commitsStatus', '❌ ' + e.message); });
}

function renderCommits() {
  if (!COMMITS.length) { $('commitsWrap').innerHTML = '<div class="empty">Aucun commit ce jour-là.</div>'; $('recapBlock').style.display = 'none'; return; }
  var byRepo = {};
  COMMITS.forEach(function (c) { (byRepo[c.repo] = byRepo[c.repo] || []).push(c); });
  var html = '';
  Object.keys(byRepo).sort().forEach(function (repo) {
    var list = byRepo[repo];
    html += '<div class="repo-group"><h3>📦 ' + esc(repo) + ' <span class="count-badge">' + list.length + '</span></h3>';
    list.forEach(function (c) {
      var branches = c.branches.map(function (b) { return '<span class="branch-chip">' + esc(b) + '</span>'; }).join(' ');
      html += '<div class="commit">'
        + '<div class="commit-head" data-repo="' + esc(repo) + '" data-sha="' + esc(c.sha) + '">'
        + '<span class="sha">' + esc(c.shortSha) + '</span>'
        + '<div style="flex:1"><div class="commit-msg">' + esc(c.message) + '</div>'
        + '<div class="commit-sub">' + esc(c.author) + ' · ' + esc(c.heure) + ' &nbsp; ' + branches + '</div></div>'
        + '<span style="color:var(--muted)">▾</span></div>'
        + '<div class="diff" id="diff-' + esc(c.sha) + '"><div class="empty">Cliquez pour charger le diff…</div></div>'
        + '</div>';
    });
    html += '</div>';
  });
  $('commitsWrap').innerHTML = html;
  buildRecap();
  $('recapBlock').style.display = 'block';
}

function toggleDiff(repo, sha) {
  var el = $('diff-' + sha);
  el.classList.toggle('open');
  if (!el.classList.contains('open') || DIFF_LOADED[sha]) return;
  el.innerHTML = '<div class="empty"><span class="spin"></span> Chargement du diff…</div>';
  gh('GET', '/repos/' + CFG.owner + '/' + repo + '/commits/' + sha).then(function (res) {
    if (res.code !== 200 || !res.json) throw new Error('Diff indisponible (HTTP ' + res.code + ').');
    DIFF_LOADED[sha] = true;
    var files = res.json.files || [], stats = res.json.stats || { additions: 0, deletions: 0 };
    var rows = files.map(function (f) {
      return '<tr><td class="fname">' + esc(f.filename) + '</td><td style="white-space:nowrap">' + statusIcon(f.status)
        + '</td><td class="add">+' + f.additions + '</td><td class="del">−' + f.deletions + '</td></tr>';
    }).join('');
    el.innerHTML = '<table>' + rows + '</table><div style="font-size:.76rem;color:var(--muted);margin-top:6px">Total : '
      + '<span class="add">+' + stats.additions + '</span> / <span class="del">−' + stats.deletions + '</span> · ' + files.length + ' fichier(s)</div>';
  }).catch(function (e) { el.innerHTML = '<div class="empty">❌ ' + e.message + '</div>'; });
}

function statusIcon(s) {
  if (s === 'added') return '🟢 ajouté';
  if (s === 'removed') return '🔴 supprimé';
  if (s === 'renamed') return '🔁 renommé';
  return '✏️ modifié';
}

function buildRecap() {
  var date = $('soirDate').value, lines = ['# Journal — ' + date, '', '## Commits du jour', ''];
  var byRepo = {};
  COMMITS.forEach(function (c) { (byRepo[c.repo] = byRepo[c.repo] || []).push(c); });
  if (!COMMITS.length) lines.push('_Aucun commit._', '');
  Object.keys(byRepo).sort().forEach(function (repo) {
    lines.push('### ' + repo);
    byRepo[repo].forEach(function (c) { lines.push('- `' + c.shortSha + '` ' + c.message + ' _(' + c.author + ', ' + c.heure + ')_'); });
    lines.push('');
  });
  var g = { fait: [], en_cours: [], a_faire: [] };
  (BACKLOG.actions || []).forEach(function (a) { (g[a.statut] || g.a_faire).push(a); });
  lines.push('## Backlog', '', '**✅ Fait**');
  g.fait.length ? g.fait.forEach(function (a) { lines.push('- [' + a.repo + '] ' + a.titre); }) : lines.push('- —');
  lines.push('', '**▶ En cours**');
  g.en_cours.length ? g.en_cours.forEach(function (a) { lines.push('- [' + a.repo + '] ' + a.titre); }) : lines.push('- —');
  lines.push('', '**⏳ À faire**');
  g.a_faire.length ? g.a_faire.forEach(function (a) { lines.push('- [' + a.repo + '] ' + a.titre); }) : lines.push('- —');
  $('recapText').value = lines.join('\n');
}

function pushRecap() {
  var date = $('soirDate').value, branch = $('soirBranch').value.trim() || 'main';
  var recap = $('recapText').value, withBacklog = $('recapWithBacklog').checked;
  var path = 'journal/' + date + '.md';
  setStatus('commitsStatus', '<span class="spin"></span> Push du récap' + (withBacklog ? ' + backlog' : '') + '…');
  ghGetContent(CFG.journalRepo, path, branch).then(function (existing) {
    return ghPutContent(CFG.journalRepo, path, recap, 'Journal ' + date + ' : récap du jour', existing ? existing.sha : null, branch);
  }).then(function () {
    if (!withBacklog) return null;
    BACKLOG.updated = new Date().toISOString();
    return ghPutContent(CFG.journalRepo, BACKLOG_PATH, JSON.stringify(BACKLOG, null, 2),
      'Journal ' + date + ' : mise à jour du backlog', BACKLOG_SHA, branch).then(function (r) {
        BACKLOG_SHA = r.content ? r.content.sha : BACKLOG_SHA;
      });
  }).then(function () {
    setStatus('commitsStatus', '✅ Récap poussé : journal/' + date + '.md' + (withBacklog ? ' + backlog' : ''));
    toast('Récap du soir poussé sur GitHub 🚀');
  }).catch(function (e) { setStatus('commitsStatus', '❌ ' + e.message); });
}

// ------------------------------- Settings ---------------------------------
function openSettings() {
  $('cfgOwner').value = CFG.owner;
  $('cfgRepos').value = CFG.repos.join(',');
  $('cfgJournal').value = CFG.journalRepo;
  $('cfgToken').value = '';
  $('settingsModal').classList.add('open');
}
function saveSettings() {
  var token = $('cfgToken').value.trim();
  if (token) lsSet(LS.token, token);
  if ($('cfgOwner').value.trim()) lsSet(LS.owner, $('cfgOwner').value.trim());
  if ($('cfgRepos').value.trim()) lsSet(LS.repos, $('cfgRepos').value.trim());
  if ($('cfgJournal').value.trim()) lsSet(LS.journal, $('cfgJournal').value.trim());
  CFG = getCfg(); fillRepoSelect();
  setStatus('cfgStatus', '✅ Enregistré.');
  toast('Configuration enregistrée');
}
function testToken() {
  setStatus('cfgStatus', '<span class="spin"></span> Test en cours…');
  var token = $('cfgToken').value.trim() || CFG.token;
  fetch(GH + '/user', { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' } })
    .then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code === 200) setStatus('cfgStatus', '✅ Connecté en tant que <b>' + esc(res.j.login) + '</b>' + (res.j.name ? ' (' + esc(res.j.name) + ')' : ''));
      else setStatus('cfgStatus', '❌ ' + esc((res.j && res.j.message) || 'Échec') + ' (HTTP ' + res.code + ')');
    }).catch(function (e) { setStatus('cfgStatus', '❌ ' + e.message); });
}

// ------------------------------- UI wiring --------------------------------
function showView(v) {
  $('view-matin').classList.toggle('active', v === 'matin');
  $('view-soir').classList.toggle('active', v === 'soir');
  $('tabMatin').classList.toggle('active', v === 'matin');
  $('tabSoir').classList.toggle('active', v === 'soir');
}

document.addEventListener('DOMContentLoaded', function () {
  $('soirDate').value = CFG.today;
  fillRepoSelect();

  $('tabMatin').addEventListener('click', function () { showView('matin'); });
  $('tabSoir').addEventListener('click', function () { showView('soir'); });
  $('btnSettings').addEventListener('click', openSettings);
  $('btnCloseSettings').addEventListener('click', function () { $('settingsModal').classList.remove('open'); });
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnTestToken').addEventListener('click', testToken);
  $('btnRefresh').addEventListener('click', loadBacklog);
  $('btnNewAction').addEventListener('click', function () { openActionModal(); });
  $('btnCloseAction').addEventListener('click', function () { $('actionModal').classList.remove('open'); });
  $('btnSaveAction').addEventListener('click', saveAction);
  $('btnSaveBacklog').addEventListener('click', saveBacklog);
  $('btnLoadCommits').addEventListener('click', loadCommits);
  $('btnPushRecap').addEventListener('click', pushRecap);

  // Délégation : cartes du backlog
  $('backlogCols').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]'); if (!b) return;
    var id = b.getAttribute('data-id'), act = b.getAttribute('data-act');
    if (act === 'edit') openActionModal(id);
    else if (act === 'del') { if (confirm('Supprimer cette action ?')) { BACKLOG.actions = BACKLOG.actions.filter(function (a) { return a.id !== id; }); renderBacklog(); } }
    else if (act === 'cycle') { var a = findAction(id); if (a) { a.statut = b.getAttribute('data-next'); a.date_faite = a.statut === 'fait' ? CFG.today : ''; renderBacklog(); } }
  });

  // Délégation : dépliage des commits
  $('commitsWrap').addEventListener('click', function (e) {
    var h = e.target.closest('.commit-head'); if (!h) return;
    toggleDiff(h.getAttribute('data-repo'), h.getAttribute('data-sha'));
  });

  if (!CFG.token) { openSettings(); setStatus('backlogStatus', '⚠️ Configurez d\'abord votre token GitHub (⚙️).'); }
  else loadBacklog();
});

// ------------------------------- Service worker ---------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  });
}
