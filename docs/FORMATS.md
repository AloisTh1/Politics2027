# Formats des données éditoriales

Toutes les données sont en YAML (UTF-8), les textes en Markdown, en français. Les mesures des
programmes sont désignées par leur identifiant tel qu'il figure dans `data/programmes/*/*.yaml`
(`RN24-001`, `RNIMM-30`, `LFI-01.01-01`, `LFIR-01`…). Dans un texte Markdown, `[[ID]]` renvoie à une
mesure ; `[[vote:id]]`, `[[eval:id]]`, `[[decl:id]]` et `[[contra:id]]` renvoient à une entrée des
fichiers ci-dessous. Les dates sont au format `AAAA-MM-JJ`.

Règles communes : chaque fait renvoie à une source en ligne (URL) consultée et datée ; aucune
citation de plus de 15 mots hors documents des partis ; ce qui n'a pas pu être vérifié est omis ou
marqué `verifie: false` avec une note. Pas d'adjectifs de jugement : on décrit, on cite, on compare.

## `research/votes.yaml` — votes à l'Assemblée nationale (16e et 17e législatures)

```yaml
- id: retraites-abrogation-2024-10        # identifiant stable, en minuscules
  sujet: "Abrogation du report de l'âge légal de départ à 64 ans"
  scrutin:
    legislature: 17
    numero: 123
    date: 2024-10-31
    intitule: "intitulé officiel du scrutin"
    url: https://www.assemblee-nationale.fr/dyn/17/scrutins/123
  mesures: [RN24-040, LFI-03.02-05]        # mesures du programme concernées
  groupes:
    rn:  {pour: 120, contre: 0, abstention: 0, non_votants: 3}
    lfi: {pour: 71, contre: 0, abstention: 0, non_votants: 0}
  coherence:                               # vote du groupe par rapport à ses écrits
    rn:  {statut: coherent, note: "…"}     # coherent | incoherent | nuance | sans-objet
    lfi: {statut: coherent, note: "…"}
```

## `research/evaluations.yaml` — évaluations indépendantes et vérifications

```yaml
- id: montaigne-rn-2024
  auteur: "Institut Montaigne"
  type: think-tank            # institution | think-tank | academique | fact-check | presse
  orientation: "libéral"      # telle que l'organisme se présente ou est couramment décrit ; facultatif
  titre: "…"
  date: 2024-06-27
  url: https://…
  partis: [rn]                # rn, lfi ou les deux
  perimetre: "Programme des législatives 2024"
  mesures: [RN24-001]
  chiffrage:                  # facultatif ; milliards d'euros par an
    cout_md: 102
    recettes_md: 18
    solde_md: -84
    horizon: "année pleine"
  conclusions:                # paraphrases fidèles et courtes
    - "…"
```

## `research/declarations.yaml` — déclarations des responsables (médias, réseaux sociaux)

```yaml
- id: bardella-retraites-2024-06-16
  parti: rn
  personne: "Jordan Bardella"
  fonction: "président du RN"
  date: 2024-06-16
  media: "TF1"                # ou « X (@J_Bardella) », « BFMTV », etc.
  url: https://…              # l'émission, le message ou un article qui le cite
  citation: "…"               # mot pour mot, courte
  sujet: "Âge de départ à la retraite"
  mesures: [RN24-040]
  rapport_au_programme: modifie   # confirme | precise | modifie | contredit
  note: "En quoi la déclaration diffère du texte écrit."
```

## `research/chiffres-2026.yaml` — chiffres officiels de référence

```yaml
- id: smic-2026
  libelle: "SMIC horaire brut au 1er janvier 2026"
  valeur: 12.02
  unite: "€"
  source: "Décret n° … / service-public.fr"
  url: https://…
  date: 2026-01-01
```

## `content/analyses/<facteur>.md` — analyses par facteur

En-tête YAML puis Markdown :

```markdown
---
titre: "Pouvoir d'achat et salaires"
facteur: pouvoir-achat
ordre: 1
themes: [classes-populaires, travail]
---
## Ce que propose le RN
…
```

Plan fixe pour chaque parti : objectifs ; moyens ; cohérence interne ; faisabilité (budgétaire,
juridique, pratique) ; qui gagne, qui paie. Puis « Points de comparaison » et « Ce qu'on ne sait
pas ».

## `content/solidite.yaml` — grille de solidité

```yaml
criteres:
  - {id: precision, libelle: "Précision", description: "…"}
  # precision, chiffrage, coherence, juridique, constance, donnees, mise-en-oeuvre
notes:
  rn:
    precision: {note: 3, justification: "… [[RN24-004]] …"}
  lfi:
    precision: {note: 4, justification: "…"}
```

## `content/themes.yaml` — synthèse par thème (comparateur)

```yaml
- theme: sante
  libelle: "Santé"
  rn: "Trois à cinq phrases neutres résumant l'approche, avec [[ID]]."
  lfi: "…"
```

## Simulateur

- `data/simulateur/bareme-2026.yaml` : paramètres de la législation 2026 (sources et URL).
- `data/simulateur/mesures.yaml` : mesures chiffrables de chaque parti (identifiant de mesure,
  paramètres, hypothèses, `statut: chiffrable | parametres-manquants`).
- `site_src/static/js/simulateur.js` : calcul côté navigateur, sans dépendance externe.
