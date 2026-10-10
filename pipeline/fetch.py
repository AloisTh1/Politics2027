"""Télécharge les documents listés dans pipeline/sources.yaml.

Chaque document est copié dans sources/raw/<id>/ (non versionné) et décrit dans
sources/manifest.json : URL demandée, URL finale, date de récupération, taille, SHA-256.
Les documents `crawl` sont parcourus page par page sans sortir de leur `scope`.

    python -m pipeline.fetch            # tout
    python -m pipeline.fetch --only lfi-aec-2025
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import time
from collections import deque
from pathlib import Path
from urllib.parse import urldefrag, urljoin, urlparse

import requests
import yaml
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "sources" / "raw"
MANIFEST = ROOT / "sources" / "manifest.json"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
SKIP_EXT = re.compile(r"\.(jpe?g|png|gif|svg|webp|mp4|mp3|zip|css|js|ico|woff2?)$", re.I)


def load_sources() -> list[dict]:
    with open(ROOT / "pipeline" / "sources.yaml", encoding="utf-8") as fh:
        return yaml.safe_load(fh)["documents"]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def slug(url: str) -> str:
    path = urlparse(url).path.strip("/") or "index"
    return re.sub(r"[^A-Za-z0-9._-]+", "_", path)[:180]


def get(session: requests.Session, url: str) -> requests.Response:
    for attempt in range(4):
        try:
            resp = session.get(url, timeout=60)
            resp.raise_for_status()
            return resp
        except requests.RequestException:
            if attempt == 3:
                raise
            time.sleep(2 ** (attempt + 1))
    raise AssertionError("unreachable")


def fetch_file(session: requests.Session, doc: dict) -> dict:
    resp = get(session, doc["url"])
    name = Path(urlparse(resp.url).path).name or f"{doc['id']}.bin"
    out = RAW / doc["id"] / name
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(resp.content)
    return {
        "files": [{
            "url": doc["url"],
            "final_url": resp.url,
            "path": str(out.relative_to(ROOT)),
            "bytes": len(resp.content),
            "sha256": sha256(resp.content),
            "content_type": resp.headers.get("content-type", ""),
        }]
    }


def crawl(session: requests.Session, doc: dict, limit: int = 2000) -> dict:
    scope = doc["scope"]
    queue, seen, files = deque([doc["url"]]), {doc["url"]}, []
    while queue and len(files) < limit:
        url = queue.popleft()
        try:
            resp = get(session, url)
        except requests.RequestException as exc:
            files.append({"url": url, "error": str(exc)})
            continue
        if "html" not in resp.headers.get("content-type", ""):
            continue
        out = RAW / doc["id"] / f"{slug(resp.url)}.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(resp.content)
        files.append({
            "url": url,
            "final_url": resp.url,
            "path": str(out.relative_to(ROOT)),
            "bytes": len(resp.content),
            "sha256": sha256(resp.content),
        })
        soup = BeautifulSoup(resp.content, "html.parser")
        for a in soup.find_all("a", href=True):
            link = urldefrag(urljoin(resp.url, a["href"]))[0]
            if link.startswith(scope) and link not in seen and not SKIP_EXT.search(link):
                seen.add(link)
                queue.append(link)
        time.sleep(0.4)
    return {"files": files}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", nargs="*")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST.read_text("utf-8")) if MANIFEST.exists() else {}
    session = requests.Session()
    session.headers["User-Agent"] = UA
    for doc in load_sources():
        if args.only and doc["id"] not in args.only:
            continue
        if not doc.get("url"):
            print(f"-- {doc['id']}: pas d'URL, ignoré")
            continue
        print(f"-> {doc['id']} ({doc['kind']})")
        entry = crawl(session, doc) if doc["kind"] == "crawl" else fetch_file(session, doc)
        entry["retrieved_at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        manifest[doc["id"]] = entry
        ok = sum(1 for f in entry["files"] if "sha256" in f)
        print(f"   {ok} fichier(s)")
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), "utf-8")


if __name__ == "__main__":
    main()
