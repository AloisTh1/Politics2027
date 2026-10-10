"""Contrôle des renvois [[…]] par un modèle local (Ollama) : chaque phrase est confrontée au texte
de la mesure ou de la source qu'elle cite. Sert au tri ; les cas signalés sont relus à la main.

Usage : python tools/check_refs.py [fichiers…]   (par défaut : analyses, solidité, brouillons de thèmes)
Sortie : work/refcheck.jsonl et un résumé sur la sortie standard.
"""
import glob
import json
import os
import re
import sys
import urllib.request

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OLLAMA = "http://127.0.0.1:11434/api/chat"
MODEL = os.environ.get("OLLAMA_MODEL", "local-9b")
REF = re.compile(r"\[\[(?:(vote|eval|decl|contra):)?([^\]]+)\]\]")


def load(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        return yaml.safe_load(f) or []


def index():
    idx = {}
    for path in glob.glob(os.path.join(ROOT, "data", "programmes", "*", "*.yaml")):
        with open(path, encoding="utf-8") as f:
            doc = yaml.safe_load(f)
        for m in doc.get("measures") or []:
            idx[m["id"]] = f"Mesure {m['id']} ({doc['doc']}, p. {m.get('page')}) : {m['text']} {m.get('detail', '')}"
    for e in load("research/evaluations.yaml"):
        idx["eval:" + e["id"]] = (
            f"Évaluation {e.get('auteur')} « {e.get('titre')} » ({e.get('date')}) ; chiffrage : {e.get('chiffrage')} ; "
            f"conclusions : {' / '.join(e.get('conclusions') or [])}"
        )
    for d in load("research/declarations.yaml"):
        idx["decl:" + d["id"]] = (
            f"Déclaration de {d.get('personne')} ({d.get('date')}, {d.get('media')}) : « {d.get('citation')} » ; "
            f"rapport au programme : {d.get('rapport_au_programme')} ; note : {d.get('note')}"
        )
    for v in load("research/votes.yaml"):
        idx["vote:" + v["id"]] = (
            f"Vote {v.get('sujet')} ; scrutin : {v.get('scrutin')} ; décomptes : {v.get('groupes')} ; "
            f"cohérence : {v.get('coherence')}"
        )
    for c in load("content/contradictions.yaml"):
        idx["contra:" + c["id"]] = f"Contradiction : {c.get('titre')}"
    return idx


def sentences(text):
    text = re.sub(r"^---.*?---", "", text, flags=re.S)
    for para in re.split(r"\n\s*\n", text):
        for s in re.split(r"(?<=[.!?])\s+(?=[A-ZÀ-Ý«])", para.replace("\n", " ")):
            if REF.search(s):
                yield s.strip()


def units():
    files = sys.argv[1:] or (
        sorted(glob.glob(os.path.join(ROOT, "content", "analyses", "*.md")))
        + [os.path.join(ROOT, "content", "solidite.yaml")]
        + sorted(glob.glob(os.path.join(ROOT, "work", "themes", "*.json")))
    )
    for path in files:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
        if path.endswith(".json"):
            raw = "\n\n".join(json.loads(raw).values())
        for s in sentences(raw):
            yield os.path.relpath(path, ROOT), s


SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["soutenu", "partiel", "non_soutenu"]},
        "raison": {"type": "string"},
    },
    "required": ["verdict", "raison"],
}


def judge(sentence, sources):
    prompt = (
        "Une phrase d'un site d'analyse politique cite des sources entre doubles crochets. Dis si les sources "
        "fournies soutiennent ce que la phrase leur attribue. « partiel » : une partie de l'affirmation n'est pas "
        "dans les sources ou les déforme légèrement ; « non_soutenu » : les sources ne disent pas cela ou disent "
        "l'inverse. Raison en une phrase.\n\nPHRASE : " + sentence + "\n\nSOURCES :\n" + "\n".join(sources)
    )
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "think": False,
        "format": SCHEMA,
        "options": {"num_ctx": 8192, "temperature": 0, "num_predict": 400},
    }
    req = urllib.request.Request(OLLAMA, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        content = json.loads(r.read())["message"]["content"]
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return {"verdict": "erreur", "raison": "réponse du modèle illisible"}


def main():
    idx = index()
    out = os.path.join(ROOT, "work", "refcheck.jsonl")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    counts = {}
    done = set()
    if os.path.exists(out):  # reprise : on ne refait pas les phrases déjà jugées
        with open(out, encoding="utf-8") as f:
            done = {(r["fichier"], r["phrase"]) for r in map(json.loads, f)}
    with open(out, "a", encoding="utf-8") as f:
        for path, s in units():
            if (path, s) in done:
                continue
            keys = [(k + ":" if k else "") + i for k, i in REF.findall(s)]
            missing = [k for k in keys if k not in idx]
            if missing:
                res = {"verdict": "ref_inconnue", "raison": ", ".join(missing)}
            else:
                res = judge(s, [idx[k] for k in keys])
            counts[res["verdict"]] = counts.get(res["verdict"], 0) + 1
            f.write(json.dumps({"fichier": path, "phrase": s, "refs": keys, **res}, ensure_ascii=False) + "\n")
            f.flush()
    print(counts)


if __name__ == "__main__":
    main()
