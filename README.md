# Au crible 2027

Analyse multifactorielle des programmes du Rassemblement national (RN) et de La France insoumise (LFI)
pour l'élection présidentielle de 2027 : lecture page par page des documents officiels, recoupement
avec les votes, les médias et les réseaux des partis, simulateur d'impact personnel et grille de
solidité des programmes.

Travail en cours : voir `research/` pour l'état d'avancement.

## Structure

- `pipeline/` : téléchargement (`fetch.py`) et découpage page par page (`extract.py`) des documents
  listés dans `pipeline/sources.yaml`.
- `data/corpus/` : texte extrait de chaque document, page par page.
- `site_src/` : gabarits, styles, scripts et polices du site.
- `sources/manifest.json` : URL, date de récupération et empreinte SHA-256 de chaque document
  (les copies locales, dans `sources/raw/`, ne sont pas versionnées).

## Construire le site

Python 3.13 est requis. Depuis la racine du dépôt :

```powershell
uv venv --python 3.13 .venv
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
.venv/Scripts/python.exe build.py
.venv/Scripts/python.exe -m unittest discover -s tests
```

Le site est généré dans `public/`. Le servir avec un serveur statique pour utiliser le simulateur
(par exemple `cd public` puis `../.venv/Scripts/python.exe -m http.server 8000`). Les fichiers
HTML, CSS, JS et polices sont locaux. La construction échoue si un renvoi
`[[...]]` pointe vers un identifiant inconnu ; `build.py --lax` affiche un avertissement à la place.
Les données éditoriales absentes produisent une page « En préparation » ou, pour les thèmes, la
liste des mesures disponibles. Les paramètres YAML du simulateur sont convertis en JSON local lors
de la construction ; `site_src/static/js/simulateur-ui.js` raccorde le formulaire au moteur.
