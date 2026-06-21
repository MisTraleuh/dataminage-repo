# LLM-assisted parser generation — Checklist

Quand aucun parser pré-existant ne couvre le jeu (cas hors STS2 / hors fork OSS),
Claude génère un parser à partir de samples du code décompilé. Ce document est
la **checklist obligatoire** que Claude doit suivre pour que la génération
soit fiable et reproductible.

> **Quand utiliser ce flow** : Phase 7 du skill `/datamine`, cas 2.
> **Quand NE PAS utiliser** : si un parser officiel/community existe (cas 1
> Phase 7) — toujours préférer un parser maintenu par la communauté.

---

## Étape 1 — Choisir 5 samples diversifiés

Pour une catégorie d'entité (ex: cards, monsters, items), choisir **5 fichiers
sources représentatifs** :

| Sample | Critère |
|--------|---------|
| 1 | **Minimal** : entité avec le moins de fields (ex: une carte basique sans powers) |
| 2 | **Maximal** : entité avec le plus de fields (ex: une carte rare avec X-cost + powers + keywords + upgrades) |
| 3 | **Edge case A** : pattern atypique (ex: X cost, conditional, status) |
| 4 | **Moyen A** : entité standard sans particularité |
| 5 | **Moyen B** : autre entité standard |

**Documenter le choix** dans le header du parser :
```
# Samples utilisés pour la génération :
# - Strike.cs : minimal (1 effet, 1 stat)
# - Catalyst+.cs : maximal (X cost, 2 powers_applied, upgrade chain)
# - Apparition.cs : edge case (Ethereal + Exhaust)
# - Defend.cs : moyen
# - SearingBlow.cs : moyen avec upgrade
```

## Étape 2 — Lire intégralement avant de coder

Lire les 5 samples **avant d'écrire une ligne de regex**. Identifier :

- **Le constructor / init pattern** : comment les fields sont assignés ?
- **Les fields toujours présents vs optionnels** : un field absent = `null` ou
  pas de ligne du tout ?
- **La représentation des listes** : array, comma-separated, sub-objects, multiple
  appels successifs (ex: `AddPower<X>(); AddPower<Y>()`) ?
- **Les templates de localisation** : SmartFormat (`{Damage:diff()}`),
  gettext (`_(`), ICU (`{var, plural}`), brut ?
- **Les patterns de référencement** entre entités : un `card` qui mentionne un
  `power` → comment ?

## Étape 3 — Écrire le parser depuis le template

Templates fournis :
- `scripts/datamine/_lib/parser-template.py` (recommandé pour C# décompilé)
- `scripts/datamine/_lib/parser-template.ts` (recommandé pour GDScript / Lua / JSON)

Règles strictes :
- **Regex ancrées** : `^...$` ou délimiteurs explicites — pas de match accidentel
- **Fail-fast** sur les patterns inconnus : `raise ParserError("unexpected pattern: ...")`
- **Output dict typé** : utiliser TypedDict (Python) ou interface (TS)
- **Pas de magie** : si un cas n'est pas géré, lever explicitement, ne pas retourner `null`

## Étape 4 — Valider par contre-exemple

Avant de lancer sur 100% des fichiers, tester sur :
- Les 5 samples (succès attendu)
- 2-3 cas "pièges" générés mentalement :
  - Une carte avec un commentaire inline qui pourrait casser la regex
  - Une entité avec un field optionnel à `null` au lieu d'absent
  - Une entité avec des caractères Unicode dans le nom

Si un piège casse le parser : revoir la regex, **ne pas** ajouter un patch
ad-hoc. Le pattern doit être robuste, pas patché.

## Étape 5 — Validation à grande échelle

```bash
python3 scripts/datamine/<slug>/parsers/parse_<entity>.py --self-test
# OU
pnpm tsx scripts/datamine/<slug>/parsers/parse_<entity>.ts --self-test
```

Le self-test doit lancer le parser sur **TOUS** les fichiers de la catégorie
(`extracted/decompiled/...Cards/`) et imprimer :

```
Parsed 576 / 580 files (99.3%)
Failures :
  - WeirdCard1.cs : ParserError "unexpected constructor signature"
  - WeirdCard2.cs : ParserError "missing 'cost' field"
  ...
```

**Cible** : ≥ 95% de succès. Si < 95% :
- Examiner 3 échecs au hasard
- Améliorer la regex pour gérer le pattern manquant
- Re-tester

Si plafond à 80–90% sur des cas extrêmes : OK, mais **lister explicitement**
les cas non gérés dans le header du parser.

## Étape 6 — Documenter dans le parser

Header obligatoire :

```python
"""
Parser pour <entity-name> dans <Game Display Name>.
Engine : <engine-id>
Généré par Claude le <YYYY-MM-DD> à partir de :
  - <sample1>
  - <sample2>
  - ...

Validation : <X> / <Y> fichiers parsés (<pourcent>%)

Cas connus non gérés :
  - <description du cas + nom du fichier exemple>
  - ...

Assumptions :
  - Le constructor du modèle est `public <Name>() : base(<cost>, <type>, <rarity>, <target>)`
  - Les powers sont déclarés via `AddPower<X>(amount)`
  - ...

Fragilité : ce parser peut casser si les devs restructurent leur code (ex:
remplacer `AddPower<X>` par `Power.Apply<X>`). Surveiller les bumps de
version.
"""
```

---

## Coût en tokens (à budgétiser)

Génération d'un parser :
- Lecture 5 samples : ~50–200 KB → ~50k tokens
- Génération du code : ~100–300 lignes → ~10k tokens
- Self-test sur 500 fichiers : pas de tokens (exécution locale)
- Itération si < 95% : ~20k tokens supplémentaires par cycle

**Total typique** : ~80k tokens par parser. Pour un jeu avec 15 entités =
~1.2M tokens (ordre de grandeur 1 dizaine de dollars Claude API).

→ Toujours **préférer un fork OSS** quand il existe.
