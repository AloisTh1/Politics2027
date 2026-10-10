"""Construit data/programmes/lfi/*.yaml à partir du corpus extrait (data/corpus/lfi-*.json).

- L'Avenir en commun 2025 : les mesures sont reprises telles quelles (blocs « mesure-cle »,
  « mesure », « sous-mesure » du site) ; thèmes de la section, complétés par des mots-clés.
- Chapitre 7 (absent des archives) : mesures citées comme « déjà présentes dans le programme
  actuel » par la synthèse des contributions de la campagne (résumés, non verbatim).
- Plans 2026 et programme NFP 2024 : puces des PDF, plus quelques engagements rédigés en prose.

Usage : python tools/build_lfi.py
"""
import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "data" / "corpus"
OUT = ROOT / "data" / "programmes" / "lfi"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lfi_order import label, locate, ordered_pages  # noqa: E402

# Thèmes par section (chapitre, section) de L'Avenir en commun 2025
SECTION_THEMES = {
    (1, 1): ["institutions"], (1, 2): ["institutions"], (1, 3): ["institutions"],
    (1, 4): ["institutions"], (1, 5): ["libertes-laicite"], (1, 6): ["libertes-laicite"],
    (2, 1): ["services-publics", "entreprises-industrie"], (2, 2): ["entreprises-industrie", "services-publics"],
    (3, 1): ["travail", "entreprises-industrie"], (3, 2): ["institutions"],
    (4, 1): ["libertes-laicite"], (4, 2): ["libertes-laicite", "securite-justice"], (4, 3): ["securite-justice"],
    (5, 1): ["education"], (5, 2): ["famille", "services-publics"], (5, 3): ["education"],
    (5, 4): ["education", "travail"], (5, 5): ["education"], (5, 6): ["education"],
    (5, 7): ["securite-justice"],
    (6, 1): ["entreprises-industrie", "fiscalite"], (6, 2): ["entreprises-industrie"],
    (6, 3): ["entreprises-industrie", "travail"], (6, 4): ["finances-publiques"], (6, 5): ["fiscalite"],
    (8, 1): ["travail", "classes-populaires"], (8, 2): ["travail"], (8, 3): ["travail"],
    (8, 4): ["travail", "classes-populaires"], (8, 5): ["travail", "classes-populaires"],
    (8, 6): ["travail"], (8, 7): ["travail", "sante"], (8, 8): ["retraites"],
    (9, 1): ["classes-populaires"], (9, 2): ["entreprises-industrie"],
    (9, 3): ["ecologie", "entreprises-industrie"],
    (10, 1): ["feminisme"], (10, 2): ["libertes-laicite"], (10, 3): ["classes-populaires", "education"],
    (10, 4): ["sante", "services-publics"], (10, 5): ["services-publics"],
    (11, 1): ["services-publics"], (11, 2): ["sante", "education"],
    (12, 1): ["ecologie"], (12, 2): ["institutions", "ecologie"], (12, 3): ["ecologie"],
    (13, 1): ["ecologie", "finances-publiques"], (13, 2): ["ecologie", "services-publics"],
    (13, 3): ["energie"], (13, 4): ["ecologie"], (13, 5): ["agriculture"],
    (14, 1): ["ecologie", "sante"], (14, 2): ["ecologie"], (14, 3): ["ecologie", "services-publics"],
    (14, 4): ["ecologie"], (14, 5): ["agriculture", "ecologie"], (14, 6): ["ecologie"],
    (15, 1): ["sante"], (15, 2): ["sante"], (15, 3): ["sante", "securite-justice"],
    (15, 4): ["sante", "agriculture"],
    **{(16, s): ["europe-international"] for s in range(1, 13)},
    (16, 7): ["immigration"],
    (17, 0): ["europe-international"], (17, 1): ["europe-international"], (17, 2): ["europe-international"],
    (18, 1): ["ecologie"], (18, 2): ["energie", "entreprises-industrie"],
    (18, 3): ["entreprises-industrie", "europe-international"],
    (18, 4): ["services-publics", "libertes-laicite"], (18, 5): ["entreprises-industrie", "libertes-laicite"],
}

# Mots-clés transversaux (appliqués à toutes les mesures, en plus des thèmes de section)
KEYWORDS = {
    "feminisme": r"\bfemmes?\b|sexis|\bIVG\b|avortement|parité|patriarcal|violences? (sexuelles|sexistes|faites aux femmes)|ménopause|prostitution|menstru|congé d.accueil",
    "classes-populaires": r"\bSMIC\b|minima sociaux|\bRSA\b|\bAPL\b|\bAAH\b|pauvreté|précarité|première nécessité|bloquer les prix|seuil de pauvreté|sans[- ]abri|garantie d.autonomie|à un euro|plus modestes|ménages modestes|quartiers populaires|minimum vieillesse",
    "logement": r"logements?\b|loyers?\b|\bAPL\b|\bHLM\b|locataires?|passoires?|expulsions? locatives?|sans[- ]abri",
    "retraites": r"retraites?\b|pensions?\b|minimum vieillesse|\bdécote\b",
    "fiscalite": r"impôts?\b|\btaxes?\b|\bTVA\b|fiscal|\bISF\b|\bCSG\b|niches?\b|droits de succession|exit tax|flat tax",
    "immigration": r"migra|\bétrangers?\b|\basile\b|\bvisas?\b|régularis|droit du sol|nationalité|aide médicale d.État|\bAME\b|Frontex|Schengen|Dublin|OFPRA|exilés",
    "energie": r"énergies?\b|énergétique|nucléaire|\bEPR\b|électricité|\bgaz\b|renouvelables?|fioul|\bEDF\b|carburants?",
    "famille": r"\bfamilles?\b|familial|petite enfance|crèches?|monoparental|congé d.accueil|parentalité",
    "sante": r"santé|médecins?\b|médicaux|hôpita|\bsoins\b",
    "securite-justice": r"\bpolice\b|policiers?|gendarm|\bjustice\b|pénal|prisons?|carcéral|magistrats?|délinquan|\bLBD\b|contrôles? d.identité",
}
KEYWORDS = {k: re.compile(v, re.I) for k, v in KEYWORDS.items()}
MAX_THEMES = 4


def themes_for(text: str, base: list[str]) -> list[str]:
    themes = list(base)
    for theme, rx in KEYWORDS.items():
        if len(themes) >= MAX_THEMES:
            break
        if theme not in themes and rx.search(text):
            themes.append(theme)
    return themes


def clean(text: str) -> str:
    # caractères de contrôle (lettrines des PDF) et espaces de largeur nulle
    text = re.sub("[\x00-\x08\x0b-\x1f​]", "", text)
    text = text.replace("œuvre s", "œuvres").replace("œuvre r", "œuvrer")
    return re.sub(r"\s+", " ", text).strip()


SUMMARIES_AEC = {
    "Sommaire": "Page d'accueil du livre-programme : table des matières (navigation seule).",
    "Introduction": "Introduction (C. Guetté, H. Clouet, J.-L. Mélenchon) : historique du programme (831 mesures, 143 ajoutées et 120 précisées dans cette édition), la « nouvelle France », les « droits de l'espèce humaine », la règle verte, la 6e République.",
}
OPENERS = {
    "Faire la révolution citoyenne": "Ouverture de la partie 1 : citations (Robespierre, Louise Michel) ; la Ve République « a fait son temps », nouvelle Constitution par le peuple.",
    "L’harmonie des êtres humains entre eux": "Ouverture de la partie 2 : citations ; égalité, services publics, partage des richesses.",
    "L’harmonie des êtres humains avec la nature": "Ouverture de la partie 3 : citations (Marx, Romain Gary) ; rompre avec le « capitalisme financiarisé », planification écologique.",
    "Ordonner le monde": "Ouverture de la partie 4 : citations (Asimov, Jaurès) ; paix, droit international, non-alignement, biens communs de l'humanité.",
}


def build_aec():
    pages, measures, claims = [], [], []
    for n, page in enumerate(ordered_pages(), start=1):
        lab = label(page["url"])
        ch, sec = locate(page["url"])
        title = clean(page["title"])
        blocks = page["blocks"]
        # mesures coupées en deux blocs par la mise en page (suite en minuscule dans un <p>)
        merged = []
        for b in blocks:
            text = clean(b["text"])
            if (b["type"] == "p" and merged and merged[-1]["type"] in ("mesure", "mesure-cle", "sous-mesure")
                    and text[:1].islower()):
                merged[-1]["text"] += " " + text
                continue
            merged.append({"type": b["type"], "text": text})
        base = SECTION_THEMES.get((int(ch), sec), []) if ch == int(ch) and ch > 0 else []
        count, key, parent = 0, None, None
        for b in merged:
            if b["type"] in ("mesure-cle", "mesure", "sous-mesure"):
                count += 1
                mid = f"LFI-{int(ch):02d}.{sec:02d}-{count:02d}"
                m = {"id": mid, "page": n, "kind": b["type"], "themes": themes_for(b["text"], base), "text": b["text"]}
                if b["type"] == "sous-mesure" and parent:
                    m["parent"] = parent
                else:
                    parent = mid
                if b["type"] == "mesure-cle":
                    key = b["text"]
                measures.append(m)
            elif re.search(r"\d+ ?% des Français", b["text"]):
                claims.append({"page": n, "kind": "sondage", "text": b["text"]})
        if lab in SUMMARIES_AEC:
            summary = SUMMARIES_AEC[lab]
        elif lab == "Ouverture de partie":
            summary = OPENERS.get(title, "Ouverture de partie.")
        elif sec == 0 and ch != 17:
            summary = f"Page d'ouverture du chapitre {int(ch)} (titre seul)."
            if ch == 7:
                summary += " Les 9 sections du chapitre manquent dans toutes les archives consultées (voir lfi-synthese-contributions)."
        else:
            first = next((b["text"] for b in merged if b["type"] == "p" and len(b["text"]) > 60), "")
            first = re.split(r"(?<=[.!?])\s", first)[0] if first else ""
            summary = f"{title}. {count} mesure(s)" + (f", dont la mesure-clé : « {key} »" if key else "") + "."
            if first:
                summary += f" Constat d'ouverture : « {first} »"
        pages.append({"n": n, "ref": lab, "url": page["url"], "title": title, "summary": summary})
    return {"doc": "lfi-aec-2025", "pages": pages, "measures": measures, "claims": claims}


CH7_SECTIONS = [
    ("L’égalité des populations par la démocratie et les services publics", ["services-publics"]),
    ("En finir avec l’abandon des Outre-mer", ["services-publics"]),
    ("Faire la société de l’entraide : généraliser l’économie sociale, solidaire et coopérative", ["entreprises-industrie"]),
    ("Éradiquer la pauvreté", ["classes-populaires"]),
    ("Garantir le droit au logement", ["logement", "classes-populaires"]),
    ("La justice au nom du peuple", ["securite-justice"]),
    ("Une politique de justice efficace", ["securite-justice"]),
    ("Une police de proximité au service de la sûreté des citoyens", ["securite-justice"]),
    ("Protéger les enfants", ["famille"]),
]


def build_synthese():
    doc = json.loads((CORPUS / "lfi-synthese-contributions.json").read_text("utf-8"))
    blocks = [{"type": b["type"], "text": clean(b["text"])} for b in doc["pages"][0]["blocks"]]
    titles = {t: th for t, th in CH7_SECTIONS}
    measures, section, collecting, i = [], None, False, 0
    for b in blocks:
        if b["type"] == "h4" and b["text"] in titles:
            section, collecting = b["text"], False
            continue
        if section is None:
            continue
        if b["type"] in ("h4", "p", "h2"):
            collecting = b["type"] == "h4" and b["text"].startswith("Parmi les") and "déjà présent" in b["text"]
            if b["type"] == "h4" and b["text"] not in titles and not b["text"].startswith(("Parmi", "Certaines")):
                section = None  # sortie du chapitre 7
            continue
        if collecting and b["type"] == "li":
            i += 1
            text = b["text"].rstrip(",;")
            measures.append({"id": f"LFI-07-S{i:02d}", "page": 1, "section": section, "verbatim": False,
                             "themes": themes_for(text, titles[section]), "text": text})
    return {
        "doc": "lfi-synthese-contributions",
        "note": ("Reconstitution partielle du chapitre 7 de L'Avenir en commun 2025 (« La force de l'entraide ») : "
                 "mesures que la campagne présente comme « déjà présentes dans le programme actuel ». "
                 "Formulations de la synthèse, pas le texte du programme."),
        "pages": [{"n": 1, "summary": "Synthèse des ~24 000 contributions citoyennes (20 mai-20 juin 2025), chapitre par chapitre : nombre de contributions, propositions déjà présentes dans le programme, propositions nouvelles."}],
        "measures": measures,
        "claims": [],
    }


def bullets(text: str) -> list[str]:
    """Puces « • » d'une page de PDF, avec leurs lignes de continuation."""
    items, cur = [], None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("•"):
            if cur:
                items.append(cur)
            cur = line.lstrip("• \t")
            continue
        if cur is None:
            continue
        if not line or re.fullmatch(r"\d+", line) or (line.isupper() and len(line) > 3):
            items.append(cur)
            cur = None
        else:
            cur += " " + line
    if cur:
        items.append(cur)
    # lettrines séparées par la mise en page (« P roduire », « L utter »)
    items = [re.sub(r"^([A-ZÉ]) ([a-zéè])", r"\1\2", clean(x)) for x in items]
    return [x for x in items if len(x) > 8]


def build_pdf(doc_id, prefix, summaries, base_themes, extra=(), skip_pages=(), objectives=()):
    doc = json.loads((CORPUS / f"{doc_id}.json").read_text("utf-8"))
    measures = []
    for page in doc["pages"]:
        if page["n"] in skip_pages:
            continue
        for text in bullets(page["text"]):
            measures.append({"page": page["n"], "text": text})
    for page, text in extra:
        measures.append({"page": page, "text": text})
    measures.sort(key=lambda m: m["page"])
    out = []
    for i, m in enumerate(measures, start=1):
        base = base_themes.get(m["page"], []) if isinstance(base_themes, dict) else base_themes
        out.append({"id": f"{prefix}-{i:02d}", "page": m["page"], "themes": themes_for(m["text"], base), "text": m["text"]})
    for o in objectives:
        out.append(o)
    pages = [{"n": p["n"], "summary": summaries.get(p["n"], "Page sans texte (photo ou page blanche).")} for p in doc["pages"]]
    return {"doc": doc_id, "pages": pages, "measures": out, "claims": []}


RURALITE_SUMMARIES = {
    1: "Couverture (image sans texte extractible).",
    2: "Page sans texte.",
    3: "Sommaire : I. diagnostic (p. 4), II. stratégie (p. 8), III. mesures (p. 12-29).",
    4: "Intercalaire de la partie I.",
    5: "« 10 ans de macronisme » : réformes territoriales, baisse des dotations ; déserts médicaux (70 % des ruraux ont renoncé à consulter), logement.",
    6: "Étalement urbain, ~70 000 défaillances d'entreprises en 2025, 62 % des communes rurales sans commerce (2021), dépendance à la voiture.",
    7: "Changement climatique dans les ruralités ; limites de l'Agenda rural et de l'ANCT ; « offensive réactionnaire » de l'extrême droite (banquets du Canon français, écosystème Stérin).",
    8: "Intercalaire de la partie II.",
    9: "La « Nouvelle France rurale » : luttes locales, Gilets jaunes, initiatives ; trois leviers.",
    10: "Leviers : communes, bifurcation écologique, proximité et relocalisation de l'emploi.",
    12: "Intercalaire de la partie III.",
    13: "1.1 Communes : abrogation des lois créant les métropoles, refus des fusions forcées, moins de pouvoir aux préfets.",
    14: "DGF rééquilibrée et indexée, fonds de soutien communal, ingénierie publique gratuite, taxe progressive sur les logements vacants.",
    15: "Statut de l'élu au-delà de la loi du 22 décembre 2025, indemnités, parité des exécutifs locaux.",
    16: "1.2 Planification écologique par des « éco-régions » ; préemption communale, défenseurs de la nature, ingénierie publique.",
    17: "Ressources : ZAN, gestion publique de l'eau, forêts ; habitat : 700 000 isolations par an, sortie du fioul et du gaz fossile, guichet unique.",
    18: "1.3 Isolement : espaces de gratuité, plan contre l'isolement des personnes âgées, écoute des agriculteurs, cafés associatifs.",
    19: "Associations (conventions pluriannuelles), espaces jeunesse, lieux culturels, équipements sportifs, petit patrimoine, fêtes populaires.",
    20: "2.1 Services publics : rôle du département, guichets physiques, états généraux des espaces ruraux, arrêt des fermetures, services itinérants ; petite enfance.",
    21: "École : 15 minutes de transport scolaire maximum, classes uniques, transports scolaires gratuits, lycées professionnels, internats gratuits.",
    22: "Santé : urgences/maternités à moins de 30 minutes, régulation de l'installation des médecins, service public de la dépendance ; zone tampon contre les pesticides.",
    23: "2.2 Discriminations : violences faites aux femmes, brigades de gendarmerie de proximité, IVG itinérante, PMA, Planning familial, mobilité des personnes handicapées.",
    24: "2.3 Transports : pôle public, renationalisation de la SNCF, réouverture des lignes, transport à la demande, leasing social, fret.",
    25: "Numérique : fibre et couverture mobile sous contrôle public, Wi-Fi public, maintien des guichets et formulaires papier.",
    26: "2.4 Emploi : aides aux commerces de village, multiservices, encadrement des grandes surfaces, tiers-lieux, garantie d'emploi.",
    27: "Industrie rurale : relocalisation, commande publique locale, aides conditionnées, ESS, reprises en coopératives.",
    28: "Agriculture paysanne : circuits courts, marchés, petites unités de transformation, filières lin/chanvre.",
    29: "2.5 Tourisme : offices mutualisés, logement des saisonniers, quotas de meublés touristiques en zone tendue, auberges de jeunesse, mobilités douces.",
    31: "Crédits photographiques.",
    32: "Quatrième de couverture : présentation des plans thématiques (coordination C. Guetté, H. Clouet).",
}
RURALITE_THEMES = {13: ["institutions"], 14: ["institutions", "fiscalite"], 15: ["institutions"], 16: ["ecologie", "institutions"],
                   17: ["ecologie"], 18: ["services-publics"], 19: ["services-publics"], 20: ["services-publics"],
                   21: ["education", "services-publics"], 22: ["sante", "services-publics"], 23: ["feminisme"],
                   24: ["services-publics", "ecologie"], 25: ["services-publics"], 26: ["entreprises-industrie", "travail"],
                   27: ["entreprises-industrie"], 28: ["agriculture"], 29: ["entreprises-industrie"]}
RURALITE_PROSE = [
    (20, "Créer un service public de la petite enfance ; en ruralités, celui-ci doit s’adapter aux contraintes et horaires des travailleur·euses"),
    (22, "Nous instaurerons une zone tampon pour protéger les enfants des pesticides et polluants autour des habitations, des crèches, des écoles et des hôpitaux"),
    (23, "Nous développerons des lieux de permanence et des solutions itinérantes pour les associations d’aide aux victimes [de violences faites aux femmes]"),
    (23, "Nous tiendrons également l’engagement de création des nouvelles brigades de gendarmerie de proximité en zone rurale"),
    (23, "Nous permettrons à chaque personne d’avoir un accès effectif à l’IVG à proximité de son domicile, y compris via des consultations itinérantes"),
    (23, "Nous renforcerons le réseau des Centres d’étude et de conservation des œufs et du sperme humains […] et développerons les consultations [de PMA] dans les hôpitaux de proximité"),
    (23, "Nous sanctuariserons et renforcerons le financement public des centres de planification et d’éducation familiale (CPEF) et des antennes du Planning familial en milieu rural"),
    (29, "Dans les zones en tension, nous régulerons les meublés touristiques, en y fixant un quota maximal de locations"),
    (29, "Garantir un accès digne au logement pour les travailleur·ses saisonnier·es et renforcer leurs droits et leurs conditions de travail"),
]

BTP_SUMMARIES = {
    1: "Couverture : « Plan d'investissement productif BTP/Logement, édition 2027 ».",
    2: "Page sans texte.",
    3: "Sommaire : bilan, besoins et objectifs, investissements, mesures de L'Avenir en commun.",
    4: "Présentation des plans d'investissement : investissement public net < 0,5 % du PIB, rôle du pôle public bancaire.",
    5: "Bilan : 350 000 sans-domicile, 2,8 millions de ménages en attente d'un logement social, 24 556 expulsions en 2024, 3 millions de logements vacants.",
    6: "Critique du « dispositif Jeanbrun » ; prix immobiliers deux fois plus rapides que les salaires ; 3 millions de passoires, MaPrimeRénov'.",
    7: "Le logement pèse 15 % des émissions ; refus de tout recul sur les normes.",
    8: "Objectif : 400 000 logements abordables par an dont 200 000 publics (140 000 PLAI) ; 150 000 par mobilisation du parc existant.",
    9: "Logements seniors, jeunes, urgence ; loi SRU durcie ; accession non spéculative (bail réel solidaire, pôle public bancaire).",
    10: "Matériaux biosourcés (50 % de la commande publique en 2032) ; 700 000 isolations par an, aide de 100 % pour les plus modestes.",
    11: "Rénovation des bâtiments publics, associatifs et tertiaires.",
    12: "Canicules : plan d'urgence dès 2027, droit opposable au confort thermique ; sortie du chauffage fossile.",
    13: "400 000 chaudières fioul et 350 000 chaudières gaz remplacées par an ; déchets du BTP.",
    14: "Réemploi (+75 % par an), formation de 250 000 salariés d'ici 2030, budget du patrimoine doublé, foncier.",
    15: "Maîtrise publique du foncier et encadrement de son prix.",
    16: "Tableau des investissements supplémentaires : 12 Md€ par an pour l'État ; plus de 300 000 emplois annoncés.",
    17: "Mesures de L'Avenir en commun liées au plan (1/2) : 200 000 logements publics, permis de louer, SRU à 30 %, réquisitions.",
    18: "Mesures de L'Avenir en commun liées au plan (2/2) : Airbnb limités à 60 jours, plafond de cinq logements transmissibles par héritage, taxe foncière progressive.",
    19: "Page sans texte.",
    20: "Quatrième de couverture : présentation des plans d'investissement productif.",
}
BTP_OBJECTIVES = [
    {"page": 8, "themes": ["logement", "classes-populaires"], "text": "Atteindre 400 000 nouveaux logements abordables par an dans les 5 prochaines années, dont 200 000 logements publics, par le biais d’une planification pluriannuelle et territorialisée", "params": {"logements_par_an": 400000, "dont_publics": 200000, "dont_tres_sociaux_PLAI": 140000}},
    {"page": 8, "themes": ["logement"], "text": "Plus de 35 % de ces logements seront créés par la mobilisation du parc existant (réquisition de logements vacants par la loi, renforcement de la taxation sur les logements vacants, changement d’usage, limitation des Airbnb, conventionnement de logements dans le parc ancien), soit 150 000 logements par an."},
    {"page": 9, "themes": ["logement", "famille"], "text": "Nous prévoirons des logements adaptés aux séniors (40 000 par an), aux jeunes étudiant·es et jeunes actifs (30 000 par an) et des logements destinés à l’hébergement d’urgence (10 000 par an)."},
    {"page": 10, "themes": ["logement", "classes-populaires", "ecologie"], "text": "nous mettrons en place un dispositif d’appui public de 100 % du montant des travaux pour les plus modestes, puis dégressif en fonction du niveau de revenus, en excluant les multipropriétaires qui détiennent plus de 5 logements."},
    {"page": 10, "themes": ["ecologie", "entreprises-industrie"], "text": "relèverons la part des rénovations lourdes ou constructions dans la commande publique faisant intervenir un matériau biosourcé ou géosourcé à 50 % d’ici 2032"},
    {"page": 12, "themes": ["logement", "sante"], "text": "Nous instaurerons également pour les locataires un droit opposable aux travaux en matière de confort thermique."},
    {"page": 13, "themes": ["energie", "logement"], "text": "Nous viserons le remplacement de 400 000 chaudières au fioul par an (quatre fois plus qu’aujourd’hui) pour quasiment les faire disparaître en 2032, et de 350 000 chaudières à gaz par an"},
    {"page": 14, "themes": ["travail", "entreprises-industrie"], "text": "Nous nous fixerons comme priorité de structurer des filières de formation (initiale et continue) avec pour objectif la formation de 250 000 salarié·es d’ici 2030."},
    {"page": 14, "themes": ["services-publics"], "text": "Nous nous donnerons l’objectif de doubler le nombre annuel de monuments dont l’état s’améliore, en multipliant par deux le budget public dédié."},
    {"page": 16, "themes": ["finances-publiques", "logement"], "text": "Investissements supplémentaires du plan BTP/logement : 12 milliards d’euros par an pour l’État ; colonne « pôle public bancaire et autres acteurs » non totalisée dans le document (36,4 Md€ par an selon notre addition des lignes).", "montant": {"etat_md_par_an": 12, "autres_acteurs_md_par_an": 36.4, "note": "36,4 = somme des lignes calculée par nous"}},
]

NFP_SUMMARIES = {
    1: "Couverture : « Contrat de législature ».",
    2: "Préambule : rupture avec la politique d'E. Macron, contre « le projet raciste et de casse sociale de l'extrême droite » ; vote les 30 juin et 7 juillet 2024.",
    3: "Partie 1, « 15 premiers jours » : 20 actes de rupture.",
    4: "Urgence sociale : blocage des prix, abrogation des décrets de la réforme des retraites, SMIC à 1 600 € net, point d'indice +10 %, APL +10 % ; logement ; climat.",
    5: "Services publics (hôpital, école), apaisement (police de proximité, interdiction des LBD), Nouvelle-Calédonie, Europe.",
    6: "Paix : diplomatie des biens communs, Afrique, APD à 0,7 % ; Ukraine : livraison d'armes, saisie des avoirs d'oligarques.",
    7: "Gaza : cessez-le-feu, otages, CPI, reconnaissance de la Palestine, embargo sur les armes, sanctions.",
    8: "Partie 2, « 100 premiers jours » : cinq paquets législatifs.",
    9: "Pouvoir d'achat (indexation des salaires, AAH au SMIC, énergie), santé (régulation de l'installation, pôle public du médicament, PFAS).",
    10: "Éducation (mixité sociale, fin de Parcoursup), garantie d'autonomie, recherche ; planification écologique.",
    11: "Énergies renouvelables, énergies marines, ASN/IRSN, barrages, Fret SNCF, adaptation au changement climatique.",
    12: "Lutte contre le racisme, l'antisémitisme et l'islamophobie ; Commissariat à l'égalité.",
    13: "Loi de finances rectificative : IR à 14 tranches, CSG progressive, ISF climatique, fin de la flat tax, héritage maximum, impôt Zucman sur les multinationales.",
    14: "Partie 3, « Les mois suivants » : les transformations.",
    15: "Services publics (30 minutes d'un accueil physique), 500 000 places de crèche, protection de l'enfance, handicap, grand âge.",
    16: "Accessibilité ; logement (200 000 logements publics par an, encadrement des loyers, garantie universelle des loyers) ; retraites (objectif 60 ans).",
    17: "6e République (proportionnelle, RIC, constituante), fin de vie ; sûreté, police de proximité, suppression de l'IGPN, justice.",
    18: "Récépissés de contrôle ; réindustrialisation, aides conditionnées, pôle public bancaire, un tiers des sièges des CA aux salariés.",
    19: "Aides aux PME-TPE, 35 h effectives et 32 h dans les métiers pénibles, « zéro mort au travail », transports (TVA à 5,5 %).",
    20: "Biodiversité, eau en régie, agriculture (CETA, Mercosur, foncier, bio).",
    21: "Glyphosate et néonicotinoïdes, jeunesse (fin du SNU), droits des femmes et des personnes LGBTQI.",
    22: "Bien-être animal, culture et médias (1 % du PIB, anti-concentration), laïcité (pas de financement public de nouveaux édifices religieux).",
    23: "Sport, numérique, Outre-mer (chlordécone, eau, plan quinquennal).",
    24: "Outre-mer (Mayotte) ; accueil des exilés : abrogation des lois asile-immigration, régularisations, AME.",
    25: "Droit du sol, libertés publiques (reconnaissance faciale interdite, lanceurs d'alerte) ; Europe : refus du pacte de stabilité, fin des traités de libre-échange.",
    26: "Vote à la majorité qualifiée sur la fiscalité ; refus du pacte budgétaire et du droit de la concurrence quand il remet en cause les services publics.",
}


# Pages du PDF NFP où les puces sont détachées du texte, ou paragraphes sans puce
NFP_EXTRA = [
    (6, "Faire des propositions en vue d’une diplomatie de promotion des biens communs planétaires : […] reconnaissance du crime d’écocide, protection des fonds marins, défense de la gestion des pôles comme bien communs de l’humanité, soutenir la création d’un tribunal international de justice climatique et environnementale"),
    (6, "Une diplomatie au service de la santé : défendre la levée des brevets sur les vaccins et les moyens médicaux de lutte contre les pandémies"),
    (6, "Une diplomatie qui garantit la démilitarisation et la dépollution de l’espace"),
    (6, "Adopter une diplomatie avec l’Afrique basée sur la souveraineté et la coopération entre les peuples, notamment via l’annulation des dettes « odieuse » de certains pays et la révision si nécessaire des accords de défense"),
    (6, "Faire respecter l’engagement de la France d’attribuer 0,7% de son RNB à l’aide publique au développement"),
    (6, "Interdire l’exportation de déchets ainsi que la production et l’exportation de pesticides dont l’usage est interdit en Europe"),
    (6, "Pour faire échec à la guerre d’agression de Vladimir Poutine […] : défendre indéfectiblement la souveraineté et la liberté du peuple ukrainien ainsi que l’intégrité de ses frontières, par la livraison d’armes nécessaires, l’annulation de sa dette extérieure, la saisie des avoirs des oligarques qui contribuent à l’effort de guerre russe dans le cadre permis par le droit international, l’envoi de casques bleus pour sécuriser les centrales nucléaires"),
    (6, "Abolir la réforme Macron du corps diplomatique"),
    (24, "Créer un fonds d’indemnisation et de prévention contre les pollutions pour indemniser et assurer la prise en charge médicale des victimes du chlordécone et des sargasses et investir dans la dépollution et la décontamination des sols et des eaux (chlordécone et glyphosate aux Antilles, mercure en Guyane, essais nucléaires en Polynésie…)"),
    (24, "Cesser de faire de Mayotte un territoire de seconde zone de la République. Étendre l’aide médicale d’État, aligner les niveaux du RSA et du SMIC sur le reste du pays et scolariser systématiquement tous les enfants"),
    (24, "Prendre systématiquement en compte les Outre-mers dans chaque texte législatif"),
    (24, "Lutter contre les situations de monopole dans les Outre-mer"),
    (24, "Proposer un principe de faveur des ultra-marins sur les postes à responsabilité et favoriser le retour des fonctionnaires d’État"),
    (24, "Favoriser l’enseignement des langues régionales en outre-mer"),
    (24, "Lancer un plan spécifique de rattrapage en matière de désenclavement routier et ferroviaire en Guyane"),
    *[(25, t) for t in [
        "Refuser le pacte de stabilité budgétaire",
        "Proposer un pacte européen pour le climat et l’urgence sociale",
        "Proposer une réforme de la Politique agricole commune (PAC)",
        "Mettre fin aux traités de libre-échange",
        "Instaurer un protectionnisme écologique et social aux frontières de l’Europe",
        "Adopter un mécanisme d’harmonisation sociale par le haut entre les États pour mettre fin aux politiques de dumping social et fiscal",
        "Réindustrialiser l’Europe : numérique, industrie du médicament, énergie, etc.",
        "Instaurer une règle verte pour prioriser des investissements verts",
        "Taxer les plus riches au niveau européen pour augmenter les ressources propres du budget de l’Union européenne",
        "Généraliser de la taxation des superprofits au niveau européen",
        "Modifier le droit de la concurrence en Europe pour garantir le droit de monopole public au niveau national"]],
    (26, "Passer au vote à la majorité qualifiée au conseil pour les questions fiscales"),
    (26, "Conformément à ce que nos groupes ont voté à l’Assemblée nationale, nous refuserons, pour l’application de notre contrat de législature, le pacte budgétaire, le droit de la concurrence lorsqu’il remet en cause les services publics et nous rejetterons les traités de libre-échange."),
]
NFP_THEMES_BY_PAGE = {6: ["europe-international"], 7: ["europe-international"], 25: ["europe-international"], 26: ["europe-international"]}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    docs = {
        "lfi-aec-2025": build_aec(),
        "lfi-synthese-contributions": build_synthese(),
        "lfi-plan-ruralite": build_pdf("lfi-plan-ruralite", "LFIR", RURALITE_SUMMARIES, RURALITE_THEMES,
                                       extra=RURALITE_PROSE, skip_pages=(31,)),
        "lfi-plan-btp-logement": build_pdf("lfi-plan-btp-logement", "LFIB", BTP_SUMMARIES, ["logement"],
                                           skip_pages=(), objectives=[]),
        "lfi-nfp-2024": build_pdf("lfi-nfp-2024", "NFP", NFP_SUMMARIES, NFP_THEMES_BY_PAGE, extra=NFP_EXTRA, skip_pages=(6, 26)),
    }
    btp = docs["lfi-plan-btp-logement"]
    for m in btp["measures"]:
        m["aec"] = True  # p. 17-18 : « principales mesures de L'Avenir en commun »
    start = len(btp["measures"])
    for i, o in enumerate(BTP_OBJECTIVES, start=start + 1):
        btp["measures"].append({"id": f"LFIB-{i:02d}", **o})
    btp["measures"].sort(key=lambda m: (m["page"], m["id"]))
    for doc_id, data in docs.items():
        path = OUT / f"{doc_id}.yaml"
        path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False, width=4096), "utf-8")
        print(f"{doc_id}: {len(data['pages'])} pages, {len(data['measures'])} mesures, {len(data['claims'])} affirmations")


if __name__ == "__main__":
    main()
