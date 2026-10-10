"""Extraire les votes RN et LFI des archives ouvertes de l'Assemblée nationale.

Usage : python tools/votes.py 16:3213 17:460
        python tools/votes.py --find "taxe sur les hauts patrimoines"

Les archives doivent être placées dans research/_cache/Scrutins-{16,17}.json.zip.
Source : https://data.assemblee-nationale.fr/ (jeu « Scrutins »).
"""

import argparse
import json
import re
import sys
import urllib.request
import html
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GROUPS = {
    16: {"rn": "PO800520", "lfi": "PO800490"},
    17: {"rn": "PO845401", "lfi": "PO845413"},
}


def load_scrutin(legislature: int, numero: int) -> dict:
    archive = ROOT / "research" / "_cache" / f"Scrutins-{legislature}.json.zip"
    member = f"json/VTANR5L{legislature}V{numero}.json"
    with zipfile.ZipFile(archive) as zf:
        return json.loads(zf.read(member))["scrutin"]


def extract(scrutin: dict) -> dict:
    legislature = int(scrutin["legislature"])
    groupes = scrutin["ventilationVotes"]["organe"]["groupes"]["groupe"]
    if isinstance(groupes, dict):
        groupes = [groupes]
    by_ref = {g["organeRef"]: g for g in groupes}
    result = {
        "legislature": legislature,
        "numero": int(scrutin["numero"]),
        "date": scrutin["dateScrutin"],
        "intitule": scrutin["titre"],
        "url": f'https://www.assemblee-nationale.fr/dyn/{legislature}/scrutins/{scrutin["numero"]}',
        "groupes": {},
    }
    for party, ref in GROUPS[legislature].items():
        group = by_ref.get(ref)
        if group is None:
            result["groupes"][party] = None
            continue
        votes = group["vote"]["decompteVoix"]
        result["groupes"][party] = {
            "pour": int(votes.get("pour") or 0),
            "contre": int(votes.get("contre") or 0),
            "abstention": int(votes.get("abstentions") or 0),
            "non_votants": int(votes.get("nonVotants") or 0),
        }
    return result


def find(term: str) -> None:
    matches = []
    for legislature in GROUPS:
        archive = ROOT / "research" / "_cache" / f"Scrutins-{legislature}.json.zip"
        with zipfile.ZipFile(archive) as zf:
            for member in zf.namelist():
                scrutin = json.loads(zf.read(member))["scrutin"]
                if scrutin["dateScrutin"] <= "2026-10-10" and re.search(term, scrutin["titre"], re.I):
                    matches.append((legislature, int(scrutin["numero"]), scrutin["dateScrutin"], scrutin["titre"]))
    for legislature, numero, date, titre in sorted(matches):
        print(f"{legislature}:{numero}\t{date}\t{titre}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scrutins", nargs="*", metavar="LEGISLATURE:NUMERO")
    parser.add_argument("--find", metavar="TEXTE", help="chercher dans les intitulés officiels")
    parser.add_argument("--verify", action="store_true", help="contrôler numéro et date sur la page officielle")
    args = parser.parse_args()
    if args.find:
        find(args.find)
    for item in args.scrutins:
        try:
            legislature, numero = map(int, item.split(":"))
            result = extract(load_scrutin(legislature, numero))
            if args.verify:
                page = urllib.request.urlopen(result["url"], timeout=20).read().decode("utf-8")
                title = re.search(r"<title>Analyse du scrutin n°\s*(\d+) - (\d+)e législature", page)
                heading = re.search(r"<h2[^>]*>[^<]*?séance du [^<]*?(\d{1,2}) ([^ <]+) (\d{4})</h2>", page, re.I)
                if not title or (int(title[1]), int(title[2])) != (numero, legislature) or not heading:
                    raise ValueError("numéro, législature ou date introuvable sur la page")
                months = {name: i for i, name in enumerate(("janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"), 1)}
                date = f"{heading[3]}-{months[heading[2].lower()]:02d}-{int(heading[1]):02d}"
                if date != result["date"]:
                    raise ValueError(f'date différente : archive {result["date"]}, page {date}')
                description = re.search(r'<meta name="description" content="Scrutin public n°\s*\d+ sur (.*?)">', page)
                if description and html.unescape(description[1]) != result["intitule"]:
                    raise ValueError("intitulé différent de la page officielle")
                result["page_verifiee"] = True
            print(json.dumps(result, ensure_ascii=False))
        except (ValueError, KeyError, FileNotFoundError) as exc:
            print(f"{item}: {exc}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
