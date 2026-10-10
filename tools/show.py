"""Affiche le texte extrait d'un document, page par page : python tools/show.py ID [DEBUT [FIN]] [--layout]"""
import json
import sys
from pathlib import Path

args = [a for a in sys.argv[1:] if not a.startswith("--")]
doc = json.loads((Path(__file__).resolve().parent.parent / "data" / "corpus" / f"{args[0]}.json").read_text("utf-8"))
first = int(args[1]) if len(args) > 1 else 1
last = int(args[2]) if len(args) > 2 else len(doc["pages"])
for page in doc["pages"][first - 1:last]:
    print(f"\n======== {args[0]} — page {page['n']}" + (f" — {page.get('title', '')}" if page.get("title") else ""))
    if "blocks" in page:
        for b in page["blocks"]:
            print(f"[{b['type']}] {b['text']}")
    else:
        print(page["layout"] if "--layout" in sys.argv else page["text"])
