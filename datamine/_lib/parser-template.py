"""
Parser pour <ENTITY> dans <GAME DISPLAY NAME>.
Engine : <engine-id>
Généré par Claude le <YYYY-MM-DD> à partir de :
  - <sample1>
  - <sample2>
  - <sample3>
  - <sample4>
  - <sample5>

Validation : <X> / <Y> fichiers parsés (<pourcent>%)

Cas connus non gérés :
  - (à remplir au fur et à mesure)

Assumptions :
  - (lister les invariants identifiés à l'étape 2 de llm-parser-gen.md)

Fragilité : (pourquoi ce parser peut casser à la prochaine version du jeu)

Usage :
  python3 parse_<entity>.py <fichier.cs>           # parse un seul fichier (debug)
  python3 parse_<entity>.py --self-test            # lance la validation 95%
  python3 parse_<entity>.py --batch <decompil-dir> # parse tous les fichiers d'un dossier
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import TypedDict, Optional


# ──────────────────────────────────────────────────────────────────────────────
# Configuration : chemin par défaut des samples (à adapter au jeu)
# ──────────────────────────────────────────────────────────────────────────────

# Convention : Claude qui édite ce template doit remplir DECOMPILED_DIR avec
# le chemin pertinent dans `extracted/decompiled/...`.
DECOMPILED_DIR = Path("extracted/decompiled/<NAMESPACE>")
SUCCESS_RATE_TARGET = 0.95


# ──────────────────────────────────────────────────────────────────────────────
# Schéma de sortie (TypedDict)
# ──────────────────────────────────────────────────────────────────────────────


class EntityRecord(TypedDict, total=False):
    id: str
    name: str
    description: Optional[str]
    # …ajouter les champs identifiés à l'étape 2
    raw_source_file: str


# ──────────────────────────────────────────────────────────────────────────────
# Exceptions
# ──────────────────────────────────────────────────────────────────────────────


class ParserError(Exception):
    """Raised when a sample doesn't match any known pattern.

    Lancer cette exception au lieu de retourner None — fail-fast aide à
    détecter les nouveaux patterns introduits par les devs du jeu.
    """


# ──────────────────────────────────────────────────────────────────────────────
# Parsing
# ──────────────────────────────────────────────────────────────────────────────


# Exemple de regex stricte (à adapter à l'engine cible)
RE_CLASS_DECL = re.compile(r"^public class (?P<id>\w+)\s*:\s*(?P<base>\w+)", re.MULTILINE)
RE_NAME_FIELD = re.compile(r'public string Name\s*=\s*"(?P<name>[^"]+)";')
RE_DESC_FIELD = re.compile(r'public string Description\s*=\s*"(?P<desc>[^"]+)";')


def parse_entity(content: str, source_file: str) -> EntityRecord:
    """Parse un fichier source décompilé en EntityRecord.

    Args:
        content: contenu UTF-8 du fichier source
        source_file: chemin source (pour le logging d'erreurs)

    Returns:
        EntityRecord avec les champs extraits

    Raises:
        ParserError: si le fichier ne match aucun pattern connu
    """
    class_match = RE_CLASS_DECL.search(content)
    if not class_match:
        raise ParserError(f"no class declaration found in {source_file}")
    entity_id = class_match.group("id")

    name_match = RE_NAME_FIELD.search(content)
    if not name_match:
        raise ParserError(f"no Name field in {source_file}")
    name = name_match.group("name")

    desc_match = RE_DESC_FIELD.search(content)
    description = desc_match.group("desc") if desc_match else None

    record: EntityRecord = {
        "id": entity_id,
        "name": name,
        "description": description,
        "raw_source_file": source_file,
    }
    return record


# ──────────────────────────────────────────────────────────────────────────────
# Batch / self-test
# ──────────────────────────────────────────────────────────────────────────────


def parse_batch(decompiled_dir: Path) -> tuple[list[EntityRecord], list[tuple[str, str]]]:
    """Parse tous les fichiers .cs d'un dossier. Retourne (records, errors)."""
    if not decompiled_dir.exists():
        raise SystemExit(f"Decompiled dir not found: {decompiled_dir}")
    records: list[EntityRecord] = []
    errors: list[tuple[str, str]] = []
    for source_file in sorted(decompiled_dir.rglob("*.cs")):
        try:
            content = source_file.read_text(encoding="utf-8")
            records.append(parse_entity(content, str(source_file)))
        except ParserError as exc:
            errors.append((str(source_file), str(exc)))
        except Exception as exc:  # noqa: BLE001 — log unexpected
            errors.append((str(source_file), f"unexpected: {type(exc).__name__}: {exc}"))
    return records, errors


def self_test() -> int:
    """Validation : lance le parser sur tout DECOMPILED_DIR et vérifie ≥ 95%."""
    records, errors = parse_batch(DECOMPILED_DIR)
    total = len(records) + len(errors)
    if total == 0:
        print(f"⚠ No files found in {DECOMPILED_DIR}", file=sys.stderr)
        return 2
    success_rate = len(records) / total
    print(f"Parsed {len(records)} / {total} files ({success_rate:.1%})")
    if errors:
        print(f"Failures ({len(errors)}) — showing first 10 :")
        for path, msg in errors[:10]:
            print(f"  - {path}: {msg}")
    if success_rate < SUCCESS_RATE_TARGET:
        print(f"✗ Below target {SUCCESS_RATE_TARGET:.0%} — review failures and improve parser")
        return 1
    print(f"✓ Above target {SUCCESS_RATE_TARGET:.0%}")
    return 0


# ──────────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────────


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if "--batch" in argv:
        idx = argv.index("--batch")
        if idx + 1 >= len(argv):
            print("--batch requires a directory argument", file=sys.stderr)
            return 1
        directory = Path(argv[idx + 1])
        records, errors = parse_batch(directory)
        print(json.dumps({"records": records, "errors": errors}, indent=2, default=str))
        return 0 if not errors else 1
    if len(argv) >= 2 and not argv[1].startswith("--"):
        source_file = Path(argv[1])
        if not source_file.exists():
            print(f"File not found: {source_file}", file=sys.stderr)
            return 1
        try:
            record = parse_entity(source_file.read_text(encoding="utf-8"), str(source_file))
            print(json.dumps(record, indent=2))
            return 0
        except ParserError as exc:
            print(f"ParserError: {exc}", file=sys.stderr)
            return 1
    print(__doc__, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
