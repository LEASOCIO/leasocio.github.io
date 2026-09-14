# 📓 Journal de Dev HSE — PWA (hébergement Pages)

Ce dépôt **public** est le **site d'organisation** GitHub Pages (`leasocio.github.io`)
et héberge la **PWA** « Journal de Dev HSE », servie à la **racine**
`https://leasocio.github.io/`. Les fichiers de l'appli sont copiés depuis le dossier
`docs/` du dépôt [`leasocio/todolist`](https://github.com/leasocio/todolist)
(source de vérité).

L'appli lit et écrit **directement l'API GitHub** depuis le navigateur : elle
continue de cibler le dépôt privé `todolist` (`journal/backlog.json`,
`journal/AAAA-MM-JJ.md`). Aucun secret n'est présent dans le code ; le **token
GitHub (PAT fine-grained)** reste sur l'appareil (`localStorage`) et n'est envoyé
qu'à `api.github.com`.

## Activer GitHub Pages
Repo `leasocio.github.io` → *Settings → Pages* → *Source : Deploy from a branch* →
branche **`main`**, dossier **`/ (root)`** → Save.
L'URL sera `https://leasocio.github.io/` (site d'organisation, à la racine — le nom
du dépôt `<compte>.github.io` est requis par GitHub pour ce type de site).

Ouvrir l'URL sur le téléphone → « Ajouter à l'écran d'accueil » → dans l'app,
**⚙️** → coller le **PAT** (*Contents: Read and write*, *Metadata: Read* sur
`leasocio/*`) → Tester → Enregistrer.

## Contenu
| Fichier | Rôle |
|---|---|
| `index.html` | interface de la PWA |
| `app.js` | logique (appels API GitHub, backlog, récaps) |
| `sw.js` | service worker (coquille hors-ligne) |
| `manifest.webmanifest` | manifeste d'installation |
| `icon-192.png`, `icon-512.png` | icônes de l'app |
