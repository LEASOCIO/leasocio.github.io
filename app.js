/* Journal de Dev HSE — PWA (client statique, API GitHub en direct) */
'use strict';

// ------------------------------- Config -----------------------------------
var LS = { token: 'gh_token', owner: 'gh_owner', repos: 'gh_repos', journal: 'gh_journal',
  contrib: 'gh_contrib', contribName: 'gh_contrib_name' };
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
    contrib: lsGet(LS.contrib, '0') === '1',       // mode contributeur (propositions only)
    contribName: lsGet(LS.contribName, ''),        // nom affiché sur les propositions
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
  var groups = { a_valider: [], en_cours: [], a_faire: [], committe: [], fait: [] };
  (BACKLOG.actions || []).forEach(function (a) { (groups[a.statut] || groups.a_faire).push(a); });
  var defs = [
    { key: 'a_valider', label: 'À valider', cls: 'avalider' },
    { key: 'en_cours', label: 'En cours', cls: 'wip' },
    { key: 'a_faire', label: 'À faire', cls: 'todo' },
    { key: 'committe', label: 'Committé', cls: 'committe' },
    { key: 'fait', label: 'Fait', cls: 'fait' }
  ];
  // La colonne « À valider » n'apparaît que s'il y a des propositions (évite une
  // colonne vide permanente pour le propriétaire quand personne n'a rien proposé).
  if (!groups.a_valider.length) defs.shift();
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
  var isProp = a.statut === 'a_valider';
  var contrib = CFG.contrib;
  var id = esc(a.id);
  var auteur = a.auteur ? '<span title="Proposé par">🙋 ' + esc(a.auteur) + '</span>' : '';
  var repoTag = isProp ? '<span class="repo-tag" title="À affecter">🙋 proposition</span>'
    : '<span class="repo-tag">' + esc(a.repo || '?') + '</span>';

  var actions;
  if (isProp) {
    // Propositions : le propriétaire valide (affecte un repo) ou rejette ; un
    // contributeur peut corriger / retirer la sienne, mais pas la valider.
    actions = contrib
      ? '<button class="mini" data-act="edit" data-id="' + id + '">✎ Éditer</button>'
        + '<button class="mini" data-act="del" data-id="' + id + '">🗑</button>'
      : '<button class="mini" data-act="valider" data-id="' + id + '">✓ Valider</button>'
        + '<button class="mini" data-act="rejeter" data-id="' + id + '">✗ Rejeter</button>';
  } else if (contrib) {
    // Contributeur : les vraies tâches sont en lecture seule (il ne fait que proposer).
    actions = '';
  } else {
    var cycle = { a_faire: 'en_cours', en_cours: 'committe', committe: 'fait', fait: 'a_faire' };
    var next = cycle[a.statut] || 'en_cours';
    var lblByNext = { en_cours: '▶ Démarrer', committe: '✓ Committé', fait: '✔ Terminer', a_faire: '↺ Rouvrir' };
    actions = '<button class="mini" data-act="cycle" data-id="' + id + '" data-next="' + next + '">' + (lblByNext[next] || '▶') + '</button>'
      + '<button class="mini" data-act="edit" data-id="' + id + '">✎ Éditer</button>'
      + '<button class="mini" data-act="del" data-id="' + id + '">🗑</button>';
  }
  return '<div class="card">'
    + '<div class="title">' + esc(a.titre) + '</div>'
    + '<div class="meta">' + repoTag + auteur
    + (a.date_faite ? '<span>✅ ' + esc(a.date_faite) + '</span>' : '') + commits + '</div>'
    + (a.notes ? '<div class="notes">' + esc(a.notes) + '</div>' : '')
    + (actions ? '<div class="card-actions">' + actions + '</div>' : '')
    + '</div>';
}

function findAction(id) { return (BACKLOG.actions || []).filter(function (a) { return a.id === id; })[0]; }

// Enregistrement automatique (anti-rebond) : chaque action du backlog est
// poussée sur GitHub sans clic manuel. Les clics rapides sont regroupés.
var _saveTimer = null, _saving = false, _dirtyAgain = false;

function scheduleAutoSave() {
  if (!CFG.token) { setStatus('backlogStatus', '⚠️ Connectez un token GitHub (⚙️) pour enregistrer.'); return; }
  setStatus('backlogStatus', '✎ Modification non enregistrée…');
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(function () { _saveTimer = null; pushBacklog(true); }, 1000);
}

// Fusionne le backlog LOCAL (édité ici) avec le backlog DISTANT (modifié par
// un autre éditeur ou par l'agent) — par identifiant d'action. Les champs
// locaux priment (statut / notes édités par l'utilisateur), MAIS les listes de
// `commits` sont UNIONNÉES (on ne perd pas les commits ajoutés par l'agent),
// et les actions présentes seulement à distance sont conservées.
function mergeBacklogs(local, remote) {
  var remoteById = {};
  (remote.actions || []).forEach(function (a) { if (a && a.id) remoteById[a.id] = a; });
  var out = [], seen = {};
  (local.actions || []).forEach(function (la) {
    if (!la || !la.id) { out.push(la); return; }
    seen[la.id] = 1;
    var ra = remoteById[la.id];
    if (!ra) { out.push(la); return; }
    var merged = Object.assign({}, ra, la); // champs locaux prioritaires
    // Union des commits (clé = sha), pour ne perdre ni ceux de l'agent ni ceux d'ici.
    var commits = [], shas = {};
    (la.commits || []).concat(ra.commits || []).forEach(function (c) {
      var k = c && (c.sha || JSON.stringify(c));
      if (k && !shas[k]) { shas[k] = 1; commits.push(c); }
    });
    merged.commits = commits;
    merged.date_faite = la.date_faite || ra.date_faite || '';
    out.push(merged);
  });
  (remote.actions || []).forEach(function (ra) { if (ra && ra.id && !seen[ra.id]) out.push(ra); });
  return out;
}

// Un envoi (PUT) ; en cas de conflit 409 (sha périmé car le fichier a changé
// ailleurs), on refusionne avec la version distante et on retente (max 3 fois).
function pushBacklogAttempt(branch, tries) {
  BACKLOG.updated = new Date().toISOString();
  var pretty = JSON.stringify(BACKLOG, null, 2);
  var payload = { message: 'Journal: mise à jour du backlog (' + CFG.today + ')', content: b64encode(pretty) };
  if (BACKLOG_SHA) payload.sha = BACKLOG_SHA;
  if (branch) payload.branch = branch;
  return gh('PUT', '/repos/' + CFG.owner + '/' + CFG.journalRepo + '/contents/' + BACKLOG_PATH, payload).then(function (res) {
    if (res.code === 200 || res.code === 201) {
      BACKLOG_SHA = (res.json && res.json.content) ? res.json.content.sha : BACKLOG_SHA;
      return { merged: tries > 0 };
    }
    if (res.code === 409 && tries < 3) {
      // Conflit de version : on relit le distant, on fusionne, on retente.
      setStatus('backlogStatus', '<span class="spin"></span> Synchronisation (conflit détecté)…');
      return ghGetContent(CFG.journalRepo, BACKLOG_PATH, branch).then(function (file) {
        if (file) {
          var remote = { actions: [] };
          try { remote = JSON.parse(file.content); } catch (e) {}
          BACKLOG.actions = mergeBacklogs(BACKLOG, remote);
          BACKLOG_SHA = file.sha;
        }
        return pushBacklogAttempt(branch, tries + 1);
      });
    }
    throw new Error('HTTP ' + res.code + (res.code === 409 ? ' (conflit persistant)' : '') + ' : ' + ((res.json && res.json.message) || ''));
  });
}

function pushBacklog(auto) {
  if (!CFG.token) { setStatus('backlogStatus', '⚠️ Token GitHub requis (⚙️).'); return Promise.resolve(); }
  if (_saving) { _dirtyAgain = true; return Promise.resolve(); }
  _saving = true;
  var branch = $('writeBranch').value.trim() || 'main';
  setStatus('backlogStatus', '<span class="spin"></span> Enregistrement…');
  return pushBacklogAttempt(branch, 0)
    .then(function (r) {
      if (r && r.merged) renderBacklog(); // la fusion a pu intégrer des actions distantes
      var t = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      setStatus('backlogStatus', '✅ Enregistré sur <b>' + esc(branch) + '</b> à ' + t + (r && r.merged ? ' (fusionné)' : ''));
      if (!auto) toast('Backlog enregistré sur GitHub');
    })
    .catch(function (e) { setStatus('backlogStatus', '❌ Échec de l\'enregistrement : ' + esc(e.message) + ' — vos changements restent en local, réessayez.'); })
    .then(function () { _saving = false; if (_dirtyAgain) { _dirtyAgain = false; scheduleAutoSave(); } });
}

// Bouton manuel « Enregistrer le backlog » : force un envoi immédiat.
function saveBacklog() { if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; } return pushBacklog(false); }

// ------------------------------- Action modal -----------------------------
function fillRepoSelect() {
  var sel = $('actRepo'); sel.innerHTML = '';
  CFG.repos.forEach(function (r) { sel.innerHTML += '<option value="' + esc(r) + '">' + esc(r) + '</option>'; });
}
function openActionModal(id, opts) {
  opts = opts || {};
  $('actId').value = id || '';
  var a = id ? findAction(id) : null;
  // Formulaire restreint pour un contributeur : en création, ou quand il édite
  // sa propre proposition (« À valider »). Il ne choisit ni repo ni statut.
  var restricted = CFG.contrib && (!a || a.statut === 'a_valider');
  $('actMetaRow').style.display = restricted ? 'none' : '';
  $('actionModalTitle').textContent = restricted
    ? (id ? '🙋 Ma proposition' : '🙋 Proposer une action')
    : (id ? '✎ Modifier l\'action' : '＋ Nouvelle action');
  $('actTitre').value = a ? a.titre : '';
  // « Valider » (propriétaire) : on pré-affecte un repo et on bascule en « À faire ».
  $('actRepo').value = a ? (a.repo || CFG.repos[0] || '') : (CFG.repos[0] || '');
  $('actStatut').value = opts.validate ? 'a_faire' : (a ? a.statut : 'a_faire');
  $('actNotes').value = a ? (a.notes || '') : '';
  $('actionModal').classList.add('open');
}
function saveAction() {
  var id = $('actId').value, titre = $('actTitre').value.trim();
  if (!titre) { toast('Titre requis'); return; }
  var notes = $('actNotes').value.trim();
  var a = id ? findAction(id) : null;
  var restricted = CFG.contrib && (!a || (a && a.statut === 'a_valider'));
  if (a) {
    a.titre = titre; a.notes = notes;
    if (!restricted) { // le propriétaire (ou hors mode contributeur) fixe repo + statut
      a.repo = $('actRepo').value; a.statut = $('actStatut').value;
    }
    var done = (a.statut === 'fait' || a.statut === 'committe');
    a.date_faite = done ? (a.date_faite || CFG.today) : '';
  } else if (restricted) {
    // Contributeur : proposition « À valider », sans repo, avec son nom.
    BACKLOG.actions.push({ id: 'a' + Date.now().toString(36), titre: titre, repo: '', statut: 'a_valider',
      notes: notes, auteur: CFG.contribName || '', date_prevue: CFG.today, date_faite: '', commits: [] });
  } else {
    var repo = $('actRepo').value, statut = $('actStatut').value;
    var done2 = (statut === 'fait' || statut === 'committe');
    BACKLOG.actions.push({ id: 'a' + Date.now().toString(36), titre: titre, repo: repo, statut: statut, notes: notes,
      date_prevue: CFG.today, date_faite: done2 ? CFG.today : '', commits: [] });
  }
  $('actionModal').classList.remove('open');
  renderBacklog();
  scheduleAutoSave();
  toast(restricted && !id ? '🙋 Proposition envoyée' : 'Action enregistrée');
}

// ------------------------------- Commits (soir) ---------------------------
var COMMITS = [], DIFF_LOADED = {}, SOIR = null;

// Numéro de semaine ISO (+ année ISO) d'une date.
function isoWeek(d) {
  var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  var day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  var ys = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  var wk = Math.ceil((((t - ys) / 86400000) + 1) / 7);
  return { year: t.getUTCFullYear(), week: wk };
}

// Plage à charger selon le mode (jour vs semaine) : bornes, libellé, nom de
// fichier du récap et titre markdown.
function soirRange() {
  var date = $('soirDate').value;
  var mode = ($('soirMode') && $('soirMode').value) || 'jour';
  if (mode === 'semaine') {
    var d = new Date(date + 'T00:00:00');
    var dow = d.getDay() || 7; // lundi = 1
    var start = new Date(d); start.setDate(d.getDate() - (dow - 1)); start.setHours(0, 0, 0, 0);
    var end = new Date(start); end.setDate(start.getDate() + 7); // borne exclusive
    var iw = isoWeek(start), ws = String(iw.week).padStart(2, '0');
    return { mode: mode, date: date, sinceISO: start.toISOString(), untilISO: end.toISOString(),
             label: 'semaine S' + ws + ' (' + iw.year + ')', fileBase: iw.year + '-S' + ws, titre: '# Récap semaine S' + ws + ' — ' + iw.year };
  }
  var s = new Date(date + 'T00:00:00'), e = new Date(s.getTime() + 24 * 3600 * 1000);
  return { mode: 'jour', date: date, sinceISO: s.toISOString(), untilISO: e.toISOString(),
           label: 'le ' + date, fileBase: date, titre: '# Journal — ' + date };
}

function loadCommits() {
  var date = $('soirDate').value;
  if (!date) { toast('Choisissez une date'); return; }
  SOIR = soirRange();
  var sinceISO = SOIR.sinceISO, untilISO = SOIR.untilISO;
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
                  jour: d ? new Date(d).toLocaleDateString('fr-CA') : '',
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
    setStatus('commitsStatus', COMMITS.length + ' commit(s) · ' + (SOIR ? SOIR.label : date) + err);
    renderCommits();
  }).catch(function (e) { setStatus('commitsStatus', '❌ ' + e.message); });
}

function renderCommits() {
  if (!COMMITS.length) { $('commitsWrap').innerHTML = '<div class="empty">Aucun commit sur cette période.</div>'; $('recapBlock').style.display = 'none'; return; }
  var byRepo = {};
  COMMITS.forEach(function (c) { (byRepo[c.repo] = byRepo[c.repo] || []).push(c); });
  var html = '';
  Object.keys(byRepo).sort().forEach(function (repo) {
    var list = byRepo[repo];
    html += '<div class="repo-group"><h3>📦 ' + esc(repo) + ' <span class="count-badge">' + list.length + '</span></h3>';
    list.forEach(function (c) {
      html += '<div class="commit">'
        + '<div class="commit-head" data-repo="' + esc(repo) + '" data-sha="' + esc(c.sha) + '">'
        + '<span class="sha">' + esc(c.shortSha) + '</span>'
        + '<div style="flex:1"><div class="commit-msg">' + esc(c.message) + '</div>'
        + '<div class="commit-sub">' + esc(c.heure) + '</div></div>'
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
  var isWeek = SOIR && SOIR.mode === 'semaine';
  var titre = (SOIR && SOIR.titre) || ('# Journal — ' + $('soirDate').value);
  var lines = [titre, '', '## Commits ' + (isWeek ? 'de la semaine' : 'du jour'), ''];
  var byRepo = {};
  COMMITS.forEach(function (c) { (byRepo[c.repo] = byRepo[c.repo] || []).push(c); });
  if (!COMMITS.length) lines.push('_Aucun commit._', '');
  Object.keys(byRepo).sort().forEach(function (repo) {
    lines.push('### ' + repo);
    if (isWeek) {
      // En semaine : on regroupe par jour (du plus récent au plus ancien).
      var byDay = {};
      byRepo[repo].forEach(function (c) { (byDay[c.jour || '?'] = byDay[c.jour || '?'] || []).push(c); });
      Object.keys(byDay).sort().reverse().forEach(function (day) {
        lines.push('- **' + day + '**');
        byDay[day].forEach(function (c) { lines.push('  - `' + c.shortSha + '` ' + c.message); });
      });
    } else {
      byRepo[repo].forEach(function (c) { lines.push('- `' + c.shortSha + '` ' + c.message + ' _(' + c.heure + ')_'); });
    }
    lines.push('');
  });
  var g = { fait: [], committe: [], en_cours: [], a_faire: [], a_valider: [] };
  // Les propositions « À valider » ont leur propre seau : elles ne polluent pas
  // le récap « À faire » tant qu'elles ne sont pas validées.
  (BACKLOG.actions || []).forEach(function (a) { (g[a.statut] || g.a_faire).push(a); });
  lines.push('## Backlog', '', '**✅ Fait**');
  g.fait.length ? g.fait.forEach(function (a) { lines.push('- [' + a.repo + '] ' + a.titre); }) : lines.push('- —');
  lines.push('', '**📦 Committé (non déployé/validé)**');
  g.committe.length ? g.committe.forEach(function (a) { lines.push('- [' + a.repo + '] ' + a.titre + (a.commits && a.commits.length ? ' (`' + a.commits.join('`, `') + '`)' : '')); }) : lines.push('- —');
  lines.push('', '**▶ En cours**');
  g.en_cours.length ? g.en_cours.forEach(function (a) { lines.push('- [' + a.repo + '] ' + a.titre); }) : lines.push('- —');
  lines.push('', '**⏳ À faire**');
  g.a_faire.length ? g.a_faire.forEach(function (a) { lines.push('- [' + a.repo + '] ' + a.titre); }) : lines.push('- —');
  $('recapText').value = lines.join('\n');
}

// ---------- Récap SEMAINE : évolution des statuts du backlog ----------
var WEEK_REVIEW = null;
function statutLabel(s) { return ({ a_faire: 'À faire', en_cours: 'En cours', committe: 'Committé', fait: 'Fait' })[s] || s || '—'; }

// État du backlog tel qu'il était au dernier commit <= untilISO (snapshot git).
function backlogAt(untilISO) {
  return gh('GET', '/repos/' + CFG.owner + '/' + CFG.journalRepo + '/commits?path=' + encodeURIComponent(BACKLOG_PATH) + '&until=' + untilISO + '&per_page=1')
    .then(function (res) {
      if (res.code !== 200 || !res.json || !res.json.length) return { actions: [] };
      return ghGetContent(CFG.journalRepo, BACKLOG_PATH, res.json[0].sha).then(function (f) {
        if (!f) return { actions: [] };
        try { return JSON.parse(f.content); } catch (e) { return { actions: [] }; }
      });
    });
}

// Compare l'état de début et de fin de semaine et classe les actions.
function computeTransitions(startBl, endBl) {
  var sMap = {}; (startBl.actions || []).forEach(function (a) { sMap[a.id] = a.statut; });
  var terminal = function (x) { return x === 'fait' || x === 'committe'; };
  var g = { termine: [], avance: [], nouveau: [], encours: [] };
  (endBl.actions || []).forEach(function (a) {
    var s = sMap[a.id], e = a.statut;
    if (s === undefined) {
      // Action apparue cette semaine : terminée d'emblée → "Terminé", sinon "Nouveau".
      if (terminal(e)) g.termine.push({ a: a, from: null, to: e });
      else if (e !== 'a_faire') g.nouveau.push({ a: a, from: null, to: e });
      return;
    }
    if (s === e) { if (e === 'en_cours') g.encours.push({ a: a, from: s, to: e }); return; }
    if (terminal(e) && !terminal(s)) g.termine.push({ a: a, from: s, to: e });
    else g.avance.push({ a: a, from: s, to: e });
  });
  g.summaryLine = g.termine.length + ' terminée(s) · ' + g.avance.length + ' avancée(s) · ' + g.nouveau.length + ' nouvelle(s)';
  return g;
}

function loadWeekReview() {
  SOIR = soirRange();
  setStatus('commitsStatus', '<span class="spin"></span> Analyse des statuts sur la semaine…');
  $('commitsWrap').innerHTML = ''; $('recapBlock').style.display = 'none';
  Promise.all([backlogAt(SOIR.sinceISO), backlogAt(SOIR.untilISO)]).then(function (r) {
    WEEK_REVIEW = computeTransitions(r[0], r[1]);
    renderWeekReview(WEEK_REVIEW);
    buildWeekRecap(WEEK_REVIEW);
    $('recapBlock').style.display = 'block';
    setStatus('commitsStatus', SOIR.label + ' — ' + WEEK_REVIEW.summaryLine);
  }).catch(function (e) { setStatus('commitsStatus', '❌ ' + e.message); });
}

// Catégories de mouvement, dans l'ordre de priorité d'affichage au sein d'un repo.
var WEEK_CATS = [
  { key: 'termine', icon: '✅', label: 'Terminé' },
  { key: 'avance',  icon: '🔄', label: 'Avancé' },
  { key: 'nouveau', icon: '➕', label: 'Nouveau' },
  { key: 'encours', icon: '⏳', label: 'En cours' }
];

// Regroupe toutes les transitions PAR REPO (volet). Renvoie une liste ordonnée
// [{ repo, items:[{ t, cat, order }] }], repos triés alphabétiquement, items
// triés par catégorie (terminé → avancé → nouveau → en cours) puis par titre.
function groupWeekByRepo(g) {
  var byRepo = {};
  WEEK_CATS.forEach(function (c, ci) {
    (g[c.key] || []).forEach(function (t) {
      var r = t.a.repo || '?';
      (byRepo[r] = byRepo[r] || []).push({ t: t, cat: c, order: ci });
    });
  });
  return Object.keys(byRepo).sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); })
    .map(function (r) {
      byRepo[r].sort(function (x, y) { return x.order - y.order || (x.t.a.titre || '').localeCompare(y.t.a.titre || ''); });
      return { repo: r, items: byRepo[r] };
    });
}

function renderWeekReview(g) {
  var groups = groupWeekByRepo(g);
  var html = groups.map(function (grp) {
    var items = grp.items.map(function (x) {
      var t = x.t;
      var trans = t.from ? (statutLabel(t.from) + ' → ' + statutLabel(t.to)) : ('✨ ' + statutLabel(t.to));
      return '<div class="commit"><div class="commit-head" style="cursor:default"><div style="flex:1">'
        + '<div class="commit-msg">' + x.cat.icon + ' ' + esc(t.a.titre) + '</div>'
        + '<div class="commit-sub">' + esc(x.cat.label) + ' &nbsp;·&nbsp; ' + esc(trans) + '</div></div></div></div>';
    }).join('');
    return '<div class="repo-group"><h3><span class="repo-tag">' + esc(grp.repo) + '</span> '
      + '<span class="count-badge">' + grp.items.length + '</span></h3>' + items + '</div>';
  }).join('');
  $('commitsWrap').innerHTML = html || '<div class="empty">Aucun mouvement de statut sur cette semaine.</div>';
}

function buildWeekRecap(g) {
  var lines = [(SOIR && SOIR.titre) || '# Récap semaine', '', '_Ce qui a bougé cette semaine, par projet._', ''];
  var groups = groupWeekByRepo(g);
  if (!groups.length) { lines.push('- —'); }
  groups.forEach(function (grp) {
    lines.push('## ' + grp.repo);
    grp.items.forEach(function (x) {
      var t = x.t;
      var trans = t.from ? ' (' + statutLabel(t.from) + ' → ' + statutLabel(t.to) + ')' : ' (✨ → ' + statutLabel(t.to) + ')';
      lines.push('- ' + x.cat.icon + ' ' + t.a.titre + trans);
    });
    lines.push('');
  });
  $('recapText').value = lines.join('\n');
}

function pushRecap() {
  var branch = $('soirBranch').value.trim() || 'main';
  var recap = $('recapText').value, withBacklog = $('recapWithBacklog').checked;
  var base = (SOIR && SOIR.fileBase) || $('soirDate').value;
  var isWeek = SOIR && SOIR.mode === 'semaine';
  var date = base; // conserve la variable pour les messages backlog ci-dessous
  var path = 'journal/' + base + '.md';
  setStatus('commitsStatus', '<span class="spin"></span> Push du récap' + (withBacklog ? ' + backlog' : '') + '…');
  ghGetContent(CFG.journalRepo, path, branch).then(function (existing) {
    return ghPutContent(CFG.journalRepo, path, recap, 'Journal ' + base + ' : récap ' + (isWeek ? 'de la semaine' : 'du jour'), existing ? existing.sha : null, branch);
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
    _recapsLoaded = false; // forcer le rechargement de la liste des récaps
  }).catch(function (e) { setStatus('commitsStatus', '❌ ' + e.message); });
}

// ------------------------------- Récaps (lecture) -------------------------
// Le matin : relire les récaps du soir déjà poussés (journal/AAAA-MM-JJ.md).
var RECAP_FILES = [], _recapsLoaded = false;

function loadRecaps(andThen) {
  setStatus('recapsStatus', '<span class="spin"></span> Chargement des récaps…');
  $('recapView').innerHTML = '';
  gh('GET', '/repos/' + CFG.owner + '/' + CFG.journalRepo + '/contents/journal').then(function (res) {
    if (res.code === 404) { $('recapsList').innerHTML = ''; setStatus('recapsStatus', 'ℹ️ Aucun dossier journal/ pour l\'instant.'); return; }
    if (res.code !== 200 || !res.json || !res.json.length) { $('recapsList').innerHTML = ''; setStatus('recapsStatus', 'ℹ️ Aucun récap pour l\'instant.'); return; }
    var files = res.json.filter(function (f) { return f.type === 'file' && /^(\d{4}-\d{2}-\d{2}|\d{4}-S\d{2})\.md$/.test(f.name); });
    files.sort(function (a, b) { return b.name.localeCompare(a.name); });
    RECAP_FILES = files;
    if (!files.length) { $('recapsList').innerHTML = ''; setStatus('recapsStatus', 'ℹ️ Aucun récap poussé pour l\'instant.'); $('recapView').innerHTML = '<div class="empty">Les récaps du soir apparaîtront ici.</div>'; return; }
    setStatus('recapsStatus', files.length + ' récap(s)');
    renderRecapsList();
    if (andThen) andThen();
    else openRecap(files[0].name); // ouvrir le dernier récap automatiquement
  }).catch(function (e) { setStatus('recapsStatus', '❌ ' + e.message); });
}

// Ouvre le dernier récap JOURNALIER antérieur à aujourd'hui (le "travail de la
// veille", robuste aux week-ends). Bascule sur l'onglet Récaps.
function ouvrirRecapVeille() {
  var open = function () {
    var veille = RECAP_FILES.filter(function (f) {
      return /^\d{4}-\d{2}-\d{2}\.md$/.test(f.name) && f.name.slice(0, 10) < CFG.today;
    })[0]; // RECAP_FILES trié décroissant → le 1er < aujourd'hui = la veille
    if (!veille) {
      setStatus('recapsStatus', 'Aucun récap de la veille.');
      $('recapView').innerHTML = '<div class="empty">Aucun récap journalier antérieur à aujourd\'hui.</div>';
      return;
    }
    openRecap(veille.name);
  };
  // On marque comme chargé AVANT showView pour éviter son auto-chargement, puis
  // on pilote nous-mêmes l'ouverture sur le récap de la veille.
  if (_recapsLoaded && RECAP_FILES.length) { showView('recaps'); open(); }
  else { _recapsLoaded = true; showView('recaps'); loadRecaps(open); }
}

function recapLabel(base) {
  var wk = base.match(/^(\d{4})-S(\d{2})$/);
  if (wk) return { full: 'Semaine S' + wk[2], w: wk[1] };
  var d = new Date(base + 'T00:00:00');
  if (isNaN(d)) return { full: base, w: '' };
  return { full: d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }), w: d.toLocaleDateString('fr-FR', { weekday: 'long' }) };
}

function renderRecapsList() {
  $('recapsList').innerHTML = RECAP_FILES.map(function (f) {
    var p = recapLabel(f.name.replace(/\.md$/, ''));
    return '<button class="recap-item" data-name="' + esc(f.name) + '"><span class="d">' + esc(p.full) + '</span><span class="w">' + esc(p.w) + '</span></button>';
  }).join('');
}

function openRecap(name) {
  Array.prototype.forEach.call(document.querySelectorAll('.recap-item'), function (el) {
    el.classList.toggle('active', el.getAttribute('data-name') === name);
  });
  $('recapView').innerHTML = '<div class="empty"><span class="spin"></span> Chargement…</div>';
  ghGetContent(CFG.journalRepo, 'journal/' + name, null).then(function (file) {
    if (!file) { $('recapView').innerHTML = '<div class="empty">Récap introuvable.</div>'; return; }
    $('recapView').innerHTML = '<div class="md">' + mdToHtml(file.content) + '</div>';
  }).catch(function (e) { $('recapView').innerHTML = '<div class="empty">❌ ' + esc(e.message) + '</div>'; });
}

// Mini-rendu Markdown (sous-ensemble produit par l'appli : titres, listes,
// gras, italique, code inline). Aucune dépendance externe.
function mdToHtml(md) {
  var lines = (md || '').replace(/\r/g, '').split('\n'), out = [], inList = false;
  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
    return s;
  }
  function closeList() { if (inList) { out.push('</ul>'); inList = false; } }
  lines.forEach(function (line) {
    var m;
    if (/^\s*$/.test(line)) { closeList(); return; }
    if ((m = line.match(/^###\s+(.*)/))) { closeList(); out.push('<h3>' + inline(m[1]) + '</h3>'); }
    else if ((m = line.match(/^##\s+(.*)/))) { closeList(); out.push('<h2>' + inline(m[1]) + '</h2>'); }
    else if ((m = line.match(/^#\s+(.*)/))) { closeList(); out.push('<h1>' + inline(m[1]) + '</h1>'); }
    else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(m[1]) + '</li>'); }
    else { closeList(); out.push('<p>' + inline(line) + '</p>'); }
  });
  closeList();
  return out.join('');
}

// ------------------------------- Settings ---------------------------------
function openSettings() {
  $('cfgOwner').value = CFG.owner;
  $('cfgRepos').value = CFG.repos.join(',');
  $('cfgJournal').value = CFG.journalRepo;
  $('cfgContrib').checked = CFG.contrib;
  $('cfgContribName').value = CFG.contribName;
  $('cfgToken').value = '';
  $('settingsModal').classList.add('open');
}
function saveSettings() {
  var token = $('cfgToken').value.trim();
  if (token) lsSet(LS.token, token);
  if ($('cfgOwner').value.trim()) lsSet(LS.owner, $('cfgOwner').value.trim());
  if ($('cfgRepos').value.trim()) lsSet(LS.repos, $('cfgRepos').value.trim());
  if ($('cfgJournal').value.trim()) lsSet(LS.journal, $('cfgJournal').value.trim());
  lsSet(LS.contrib, $('cfgContrib').checked ? '1' : '0');
  lsSet(LS.contribName, $('cfgContribName').value.trim());
  CFG = getCfg(); fillRepoSelect();
  renderBacklog(); // le mode contributeur change l'affichage (colonnes / boutons)
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
  ['matin', 'soir', 'recaps'].forEach(function (name) {
    var sec = $('view-' + name); if (sec) sec.classList.toggle('active', name === v);
    var tab = $('tab' + name.charAt(0).toUpperCase() + name.slice(1)); if (tab) tab.classList.toggle('active', name === v);
  });
  if (v === 'recaps' && !_recapsLoaded && CFG.token) { _recapsLoaded = true; loadRecaps(); }
}

document.addEventListener('DOMContentLoaded', function () {
  $('soirDate').value = CFG.today;
  fillRepoSelect();

  $('tabMatin').addEventListener('click', function () { showView('matin'); });
  $('tabSoir').addEventListener('click', function () { showView('soir'); });
  $('tabRecaps').addEventListener('click', function () { showView('recaps'); });
  $('btnLoadRecaps').addEventListener('click', function () { _recapsLoaded = true; loadRecaps(); });
  $('recapsList').addEventListener('click', function (e) {
    var b = e.target.closest('.recap-item'); if (!b) return;
    openRecap(b.getAttribute('data-name'));
  });
  $('btnSettings').addEventListener('click', openSettings);
  $('btnCloseSettings').addEventListener('click', function () { $('settingsModal').classList.remove('open'); });
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnTestToken').addEventListener('click', testToken);
  $('btnRefresh').addEventListener('click', loadBacklog);
  $('btnNewAction').addEventListener('click', function () { openActionModal(); });
  $('btnRecapVeille').addEventListener('click', ouvrirRecapVeille);
  $('btnCloseAction').addEventListener('click', function () { $('actionModal').classList.remove('open'); });
  $('btnSaveAction').addEventListener('click', saveAction);
  $('btnSaveBacklog').addEventListener('click', saveBacklog);
  $('btnLoadCommits').addEventListener('click', function () {
    var mode = ($('soirMode') && $('soirMode').value) || 'jour';
    if (mode === 'semaine') loadWeekReview(); else loadCommits();
  });
  if ($('soirMode')) $('soirMode').addEventListener('change', function () {
    $('btnLoadCommits').textContent = ($('soirMode').value === 'semaine') ? '📊 Analyser la semaine' : '📥 Charger les commits';
  });
  $('btnPushRecap').addEventListener('click', pushRecap);

  // Délégation : cartes du backlog
  $('backlogCols').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]'); if (!b) return;
    var id = b.getAttribute('data-id'), act = b.getAttribute('data-act');
    if (act === 'edit') openActionModal(id);
    else if (act === 'valider') openActionModal(id, { validate: true }); // propriétaire : affecte un repo, passe en « À faire »
    else if (act === 'rejeter') { if (confirm('Rejeter (supprimer) cette proposition ?')) { BACKLOG.actions = BACKLOG.actions.filter(function (a) { return a.id !== id; }); renderBacklog(); scheduleAutoSave(); } }
    else if (act === 'del') { if (confirm('Supprimer cette action ?')) { BACKLOG.actions = BACKLOG.actions.filter(function (a) { return a.id !== id; }); renderBacklog(); scheduleAutoSave(); } }
    else if (act === 'cycle') { var a = findAction(id); if (a) { a.statut = b.getAttribute('data-next'); a.date_faite = (a.statut === 'fait' || a.statut === 'committe') ? CFG.today : ''; renderBacklog(); scheduleAutoSave(); } }
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
