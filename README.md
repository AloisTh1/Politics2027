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
