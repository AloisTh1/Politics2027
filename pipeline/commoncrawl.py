"""Récupère des pages web archivées par Common Crawl (https://commoncrawl.org).

Utilisé quand un document a été retiré de son site d'origine : l'édition 2025 de
« L'Avenir en commun » n'est plus en ligne sur melenchon2027.fr depuis l'annonce de la
5e édition, mais Common Crawl l'a archivée en mai 2026.

Pour chaque URL capturée (statut 200, HTML), l'enregistrement WARC est lu par plage
d'octets sur data.commoncrawl.org et la réponse HTML est enregistrée telle quelle.
La provenance (collection, horodatage, fichier WARC, position, empreinte) est
conservée dans sources/manifest.json.
"""

from __future__ import annotations

import gzip
import json
import time

import requests

INDEX = "https://index.commoncrawl.org/{crawl}-index"
DATA = "https://data.commoncrawl.org/"


def _retry(fn, attempts: int = 6):
    for attempt in range(attempts):
        try:
            return fn()
        except requests.RequestException:
            if attempt == attempts - 1:
                raise
            time.sleep(min(60, 5 * 2 ** attempt))


def query(crawl: str, url_pattern: str) -> list[dict]:
    """Toutes les captures d'un motif d'URL dans une collection (l'index est souvent saturé)."""

    def call():
        resp = requests.get(
            INDEX.format(crawl=crawl),
            params={"url": url_pattern, "output": "json"},
            timeout=300,
        )
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        return [json.loads(line) for line in resp.text.splitlines() if line.startswith("{")]

    return _retry(call)


def fetch_record(rec: dict) -> tuple[bytes, dict]:
    """Corps HTTP (HTML) d'une capture, et en-têtes WARC utiles."""
    start = int(rec["offset"])
    end = start + int(rec["length"]) - 1

    def call():
        resp = requests.get(DATA + rec["filename"], headers={"Range": f"bytes={start}-{end}"}, timeout=120)
        resp.raise_for_status()
        return resp.content

    raw = gzip.decompress(_retry(call))
    warc_head, _, rest = raw.partition(b"\r\n\r\n")
    _http_head, _, body = rest.partition(b"\r\n\r\n")
    headers = {}
    for line in warc_head.decode("utf-8", "replace").splitlines()[1:]:
        key, _, value = line.partition(":")
        headers[key.strip()] = value.strip()
    return body, headers
