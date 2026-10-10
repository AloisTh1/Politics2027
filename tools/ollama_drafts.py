"""Brouillons rédigés par un modèle local (Ollama) à partir des seules mesures des programmes.

Trois passes, écrites dans work/ (non versionné) pour relecture et réécriture :
  - analyses par facteur        -> work/analyses/<facteur>.md
  - synthèses par thème         -> work/themes/<theme>.json
  - contradictions candidates   -> work/contra/<parti>-<facteur>.json

Usage : python tools/ollama_drafts.py [analyses|themes|contra ...]
"""
import glob
import json
import os
import sys
import time
import urllib.request

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, "work")
OLLAMA = "http://127.0.0.1:11434/api/chat"
MODEL = os.environ.get("OLLAMA_MODEL", "local-27b")

FACTEURS = [
    ("pouvoir-achat", "Pouvoir d'achat, salaires et travail", ["classes-populaires", "travail"]),
    ("fiscalite", "Impôts, dépense publique et dette", ["fiscalite", "finances-publiques"]),
    ("retraites", "Retraites", ["retraites"]),
    ("sante", "Santé", ["sante"]),
    ("education", "École, enseignement supérieur et jeunesse", ["education"]),
    ("logement", "Logement", ["logement"]),
    ("ecologie-energie", "Écologie et énergie", ["ecologie", "energie"]),
    ("economie", "Entreprises, industrie et agriculture", ["entreprises-industrie", "agriculture"]),
    ("services-publics", "Services publics", ["services-publics"]),
    ("famille-egalite", "Familles et égalité femmes-hommes", ["famille", "feminisme"]),
    ("immigration", "Immigration", ["immigration"]),
    ("securite-justice", "Sécurité et justice", ["securite-justice"]),
    ("europe-international", "Europe, défense et international", ["europe-international"]),
    ("institutions-libertes", "Institutions, libertés et laïcité", ["institutions", "libertes-laicite"]),
]
PARTIS = {"rn": "Rassemblement national (RN)", "lfi": "La France insoumise (LFI)"}

SYSTEME = (
    "Tu es un analyste politique rigoureux et strictement neutre. Tu écris en français clair, sans "
    "adjectifs de jugement ni formules militantes. Tu n'utilises QUE les mesures fournies : n'invente "
    "aucun chiffre, aucune date, aucune source. Chaque affirmation sur un programme cite l'identifiant "
    "de la mesure entre doubles crochets, par exemple [[RN24-001]]. Quand un jugement demande des "
    "données extérieures (coût, conformité à la Constitution ou au droit européen, effets économiques), "
    "tu ne tranches pas : tu écris une ligne « À vérifier : … » qui dit précisément quoi vérifier."
)


def load_measures():
    out = {"rn": [], "lfi": []}
    for path in sorted(glob.glob(os.path.join(ROOT, "data", "programmes", "*", "*.yaml"))):
        parti = os.path.basename(os.path.dirname(path))
        with open(path, encoding="utf-8") as f:
            doc = yaml.safe_load(f)
        for m in doc.get("measures") or []:
            out[parti].append({**m, "doc": doc["doc"]})
    return out


def lines(measures, themes):
    rows = []
    for m in measures:
        if set(m.get("themes", [])) & set(themes):
            detail = f" — {m['detail']}" if m.get("detail") else ""
            rows.append(f"- {m['id']} ({m['doc']}, p. {m.get('page')}) : {m['text']}{detail}")
    return rows


def chat(prompt, fmt=None, max_tokens=4096):
    body = {
        "model": MODEL,
        "messages": [{"role": "system", "content": SYSTEME}, {"role": "user", "content": prompt}],
        "stream": False,
        "think": False,
        "options": {"num_ctx": int(os.environ.get("OLLAMA_CTX", "32768")), "temperature": 0.3, "num_predict": max_tokens},
    }
    if fmt:
        body["format"] = fmt
    req = urllib.request.Request(OLLAMA, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=1800) as r:
        return json.loads(r.read())["message"]["content"]


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def analyses(ms):
    for slug, titre, themes in FACTEURS:
        out = os.path.join(WORK, "analyses", f"{slug}.md")
        if os.path.exists(out):
            continue
        blocs = []
        for p, nom in PARTIS.items():
            ls = lines(ms[p], themes)
            blocs.append(f"### Mesures du {nom} ({len(ls)})\n" + ("\n".join(ls) or "(aucune)"))
        prompt = (
            f"Rédige le brouillon de l'analyse « {titre} » pour un site qui compare les programmes du RN et "
            "de LFI pour la présidentielle 2027. Plan obligatoire, en Markdown :\n"
            "## Ce que propose le RN\n### Objectifs\n### Moyens\n### Cohérence interne\n"
            "### Faisabilité (budgétaire, juridique, pratique)\n### Qui gagne, qui paie\n"
            "## Ce que propose LFI\n(mêmes sous-parties)\n## Points de comparaison\n## Ce qu'on ne sait pas\n\n"
            "Consignes : 900 à 1 400 mots ; même longueur et même exigence pour les deux partis ; cite les "
            "mesures les plus structurantes (pas toutes) ; signale les mesures d'un même parti qui semblent "
            "difficiles à tenir ensemble ; signale les mesures sans chiffrage ni calendrier.\n\n" + "\n\n".join(blocs)
        )
        log(f"analyse {slug}")
        write(out, f"<!-- brouillon {MODEL}, {time.strftime('%Y-%m-%d')} -->\n" + chat(prompt))


THEME_SCHEMA = {
    "type": "object",
    "properties": {"rn": {"type": "string"}, "lfi": {"type": "string"}},
    "required": ["rn", "lfi"],
}


def themes(ms):
    tous = sorted({t for p in ms.values() for m in p for t in m.get("themes", [])})
    for t in tous:
        out = os.path.join(WORK, "themes", f"{t}.json")
        if os.path.exists(out):
            continue
        blocs = [f"### {PARTIS[p]}\n" + "\n".join(lines(ms[p], [t])) for p in PARTIS]
        prompt = (
            f"Thème « {t} ». Pour chaque parti, résume son approche en 3 à 5 phrases neutres, en citant 2 à 4 "
            "mesures représentatives [[ID]]. Réponds en JSON {\"rn\": \"…\", \"lfi\": \"…\"}.\n\n" + "\n\n".join(blocs)
        )
        log(f"theme {t}")
        write(out, chat(prompt, fmt=THEME_SCHEMA, max_tokens=1500))


CONTRA_SCHEMA = {
    "type": "object",
    "properties": {
        "candidats": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "a": {"type": "string"},
                    "b": {"type": "string"},
                    "raison": {"type": "string"},
                    "confiance": {"type": "integer", "minimum": 1, "maximum": 3},
                },
                "required": ["a", "b", "raison", "confiance"],
            },
        }
    },
    "required": ["candidats"],
}


def contra(ms):
    for slug, titre, ts in FACTEURS:
        for p, nom in PARTIS.items():
            out = os.path.join(WORK, "contra", f"{p}-{slug}.json")
            if os.path.exists(out):
                continue
            ls = lines(ms[p], ts)
            if len(ls) < 2:
                continue
            prompt = (
                f"Voici les mesures du {nom} sur « {titre} ». Repère au plus 5 paires de mesures qui ne "
                "peuvent pas être tenues ensemble (incompatibilité logique, budgétaire ou juridique) ou deux "
                "chiffrages différents d'une même mesure. Une évolution entre deux documents de dates "
                "différentes compte seulement si l'ancien texte est présenté comme toujours valable. "
                "N'invente rien ; si aucune paire n'est solide, renvoie une liste vide. confiance : 1 faible, "
                "3 forte. Réponds en JSON.\n\n" + "\n".join(ls)
            )
            log(f"contra {p} {slug}")
            write(out, chat(prompt, fmt=CONTRA_SCHEMA, max_tokens=2000))


if __name__ == "__main__":
    passes = sys.argv[1:] or ["analyses", "themes", "contra"]
    ms = load_measures()
    for name in passes:
        {"analyses": analyses, "themes": themes, "contra": contra}[name](ms)
    log("terminé")
