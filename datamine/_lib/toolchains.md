# Toolchains par engine — Plan A / B / C

Pour chaque engine supporté par le pipeline `/datamine`, ce document liste les
recettes d'extraction et de décompilation. **Plan A** = recommandé, tenté en
premier. **Plan B/C** = fallbacks si A échoue (validation 38.11 KO).

Le skill `/datamine` consulte ce fichier en Phase 4/5. Le script
`check-tools.mjs` consulte `tool-registry.json` (formellement structuré) pour
vérifier l'install.

---

## Pré-requis 0 — Décompression du zip (multi-format)

**Avant** d'extraire le contenu du jeu, il faut savoir décompresser le zip
lui-même. Tous les zips ne sont pas identiques :

| Méthode (PKWARE) | Nom | Outils qui supportent |
|---|---|---|
| 0 | stored (aucune compression) | tous |
| 8 | deflate (standard) | unzip natif, Python stdlib, 7z, WinRAR |
| 9 | deflate64 | 7z, WinRAR (PAS unzip Info-ZIP) |
| 12 | bzip2 | unzip recent, Python, 7z |
| 14 | lzma | Python, 7z |
| **93** | **Zstandard** | **7z, Python+`zstandard` package** (PAS unzip) |
| 95 | xz | 7z |

**Cas vécu (STS2 v0.103.2)** : zip AnkerGames utilise méthode 93 (Zstandard).
`unzip` plante avec "unsupported compression method 93". Solution : Python +
lib `zstandard` avec monkey-patch `zipfile._get_decompressor`.

**Stratégie recommandée** : utiliser `node datamine/_lib/extract-zip.mjs` :
- `--probe` : détecte les méthodes utilisées sans extraire + indique le meilleur extracteur dispo
- `--out=<dir>` : extrait avec auto-fallback (unzip → Python+zstd → 7z → WinRAR)
- `--pattern="A/*.pck"` : extraction sélective (économise le disque sur les gros zips)

Si aucun extracteur n'est dispo pour les méthodes du zip :
- méthode 93 → `pip install --user zstandard` (1 minute)
- méthode 9 → installer 7-Zip via `winget install -e --id 7zip.7zip` (Windows) ou `apt install p7zip-full` (Linux)

---

## Format de sortie commun

Quel que soit l'engine, après extraction le workspace doit contenir :

```
datamine/<game-slug>/extracted/
├── raw/                          # assets bruts (images, locale, configs)
├── decompiled/                   # code décompilé (.cs, .gd, .gml, …)
└── manifest.json                 # méta extraction (engine, plan utilisé, durée, counts)
```

`extracted/manifest.json` schéma :

```json
{
  "engine": "godot4-csharp",
  "plan_used": "A",
  "tools_versions": { "gdre_tools": "v0.6.2", "ilspycmd": "8.2.0" },
  "extracted_at": "2026-04-26T...",
  "duration_seconds": 87.3,
  "validation_status": "passed",
  "counts": { "raw_files": 9947, "decompiled_files": 3287 }
}
```

---

## `godot4-csharp` — Godot 4 + C# (.NET)

**Cas d'école** : Slay the Spire 2 (`sts2.dll` + `SlayTheSpire2.pck`).

### Plan A — gdsdecomp + ilspycmd (recommandé)

```bash
# Asset extraction (PCK → raw assets, locales, Spine animations)
gdre_tools --headless --recover="<game-dir>/SlayTheSpire2.pck" \
  --output-dir="extracted/raw"

# Code decompilation (sts2.dll → ~3300 .cs files)
ilspycmd -p \
  -o "extracted/decompiled" \
  "<game-dir>/data_*_*/sts2.dll"
```

- **gdre_tools** : https://github.com/bruvzg/gdsdecomp (Godot RE Tools)
  - Version pinning : `v0.6.2` minimum
  - Plateformes : Windows, Linux. macOS = `manual` (binaire non signé)
  - Vérifier post-extraction : `extracted/raw/localization/eng/` doit avoir ≥ 5 fichiers
- **ilspycmd** : https://github.com/icsharpcode/ILSpy
  - Install : `dotnet tool install -g ilspycmd --version 8.2.0`
  - Cross-platform via .NET 8 SDK
  - Vérifier post-decompile : `extracted/decompiled/MegaCrit.Sts2.Core.Models.Cards/` (ou pattern équivalent du jeu) doit exister

### Plan B — gdre_tools GUI + ilspycmd

Si la CLI plante sur des PCK trop récents (Godot 4.4+) ou trop volumineux :

1. Lancer `gdre_tools.exe` en mode GUI (drag-drop le `.pck`)
2. Cocher "Recover Project" + "Extract All Files"
3. Pointer la sortie vers `extracted/raw/`
4. Reprendre la decompil DLL avec ilspycmd (plan A)

### Plan C — godot-pck-tool + dnSpyEx

- **godot-pck-tool** : https://github.com/hhyyrylainen/GodotPckTool — extraction brute du PCK sans recovery
- **dnSpyEx** : https://github.com/dnSpyEx/dnSpy — alternative à ilspycmd si l'IL est obfusqué (rare sur les jeux indie Godot)

```bash
godot-pck-tool extract "<game-dir>/SlayTheSpire2.pck" --output extracted/raw
# dnSpyEx en mode CLI (Windows uniquement) — sinon GUI manuel
```

---

## `godot4-gdscript` — Godot 4 + GDScript only

### Plan A — gdsdecomp avec script recovery

```bash
gdre_tools --headless --recover="<game-dir>/<Game>.pck" \
  --output-dir="extracted/raw" \
  --bytecode-version=auto
```

- Les scripts `.gd` recovered sont dans `extracted/raw/scripts/` ou similaire
- Pas de décompilation .NET nécessaire — `extracted/decompiled/` peut rester vide ou pointer vers les `.gd`

### Plan B — gdre_tools en mode "extract only"

Si le recovery .gd échoue (bytecode trop récent) :

```bash
gdre_tools --headless --extract="<game-dir>/<Game>.pck" \
  --output-dir="extracted/raw"
```

Les scripts seront en bytecode `.gdc`/`.gde` non lisibles. Les configs et locales restent exploitables.

### Plan C — godot-pck-tool

Identique au Plan C de `godot4-csharp`.

---

## `godot3` — Godot 3.x (legacy)

### Plan A — gdsdecomp branche legacy

```bash
gdre_tools --headless --recover="<game-dir>/<Game>.pck" \
  --output-dir="extracted/raw" \
  --legacy
```

### Plan B / C

Idem `godot4-gdscript`.

---

## `unity-mono` — Unity (Mono backend)

### Plan A — AssetRipper + ilspycmd

```bash
# Asset extraction (scenes, prefabs, ScriptableObjects → YAML)
dotnet AssetRipper.GUI.Free.dll \
  --commands="LoadFolder=<game-dir>" \
  --commands="ExportProject=extracted/raw"

# Code decompilation
ilspycmd -p \
  -o "extracted/decompiled" \
  "<game-dir>/<Game>_Data/Managed/Assembly-CSharp.dll"
```

- **AssetRipper** : https://github.com/AssetRipper/AssetRipper
  - Free Edition : MIT, .NET 8 cross-platform
  - Version pinning : `0.3.4.0` ou plus récent
  - Sortie : Unity project `.unity` reconstructible

### Plan B — AssetStudio + ilspycmd

- **AssetStudio** : https://github.com/Perfare/AssetStudio
  - Plus rapide mais focus sur les assets graphiques + ScriptableObjects (data brut)
  - Idéal si AssetRipper produit un projet trop "Unity-formatted" pour parser

### Plan C — UABEA + dnSpyEx

- **UABEA** : https://github.com/nesrak1/UABEA — éditeur AssetBundle natif, accès très bas niveau
- Utile quand AssetRipper se plante sur des AssetBundles chiffrés

---

## `unity-il2cpp` — Unity (IL2CPP backend)

### Plan A — AssetRipper + IL2CppDumper + ilspycmd

```bash
# 1. Asset extraction (idem unity-mono)
dotnet AssetRipper.GUI.Free.dll \
  --commands="LoadFolder=<game-dir>" \
  --commands="ExportProject=extracted/raw"

# 2. IL2CPP → dummy DLLs reconstruits depuis global-metadata.dat
Il2CppDumper.exe \
  "<game-dir>/GameAssembly.dll" \
  "<game-dir>/<Game>_Data/il2cpp_data/Metadata/global-metadata.dat" \
  "extracted/.tmp-il2cpp"

# 3. Decompilation des dummy DLLs via ilspycmd
ilspycmd -p \
  -o "extracted/decompiled" \
  "extracted/.tmp-il2cpp/DummyDll/Assembly-CSharp.dll"
```

- **IL2CppDumper** : https://github.com/Perfare/Il2CppDumper
  - Windows release uniquement
  - Version pinning : `v6.7.46` minimum
  - Échec fréquent sur Unity 2022.3+ (format global-metadata évolue)

### Plan B — Il2CppInspector

- **Il2CppInspector** : https://github.com/djkaty/Il2CppInspector
- Plus précis sur Unity 2021/2022 récents
- Sortie similaire (dummy DLLs)

### Plan C — Cpp2IL

- **Cpp2IL** : https://github.com/SamboyCoding/Cpp2IL
- Pour les versions IL2CPP les plus récentes (Unity 2023+)
- Moins mature que IL2CppDumper mais survit aux dernières versions

---

## `ue4` — Unreal Engine 4

### Plan A — FModel CLI

```bash
# Listing + export ciblé
FModel.exe \
  --gameDir="<game-dir>" \
  --output="extracted/raw" \
  --exportType="json" \
  --exportTexturesAs="png"
```

- **FModel** : https://github.com/4sval/FModel
  - .NET 9, Windows + macOS
  - Version pinning : `4.4.0` minimum
- Les `.uasset` sont exportés en JSON parsable

### Plan B — UAssetGUI

- **UAssetGUI** : https://github.com/atenfyr/UAssetGUI
- Inspection fine fichier par fichier, plus lent mais plus précis sur les types custom

### Plan C — UEViewer (umodel)

- **UEViewer** : https://github.com/gildor2/UEViewer
- Plus ancien, robuste sur les anciens jeux UE4
- Sortie en formats classiques (PSK, PSA, TGA)

**Note** : pour UE4/UE5, le code source C++ n'est pas décompilable utilement.
Les data et logique métier sont dans les `.uasset` (Blueprints + DataAssets).

---

## `ue5` — Unreal Engine 5

### Plan A — FModel récent

Identique au Plan A de UE4, mais FModel doit être ≥ 4.4 pour supporter
le format IoStore (`.utoc`/`.ucas`).

### Plan B — UEViewer mode UE5

Support partiel — meilleur fallback quand FModel cale sur des packs chiffrés.

### Plan C — UAssetAPI direct

- **UAssetAPI** : https://github.com/atenfyr/UAssetAPI
- Bibliothèque .NET pour parser `.uasset` programmatically après extraction `.pak`
- Combiné avec **PakDecrypt** si chiffrement AES

---

## `gms2` — GameMaker Studio 2

### Plan A — UndertaleModTool CLI

```bash
UndertaleModCli.exe load "<game-dir>/data.win" \
  --script="<repo>/datamine/_lib/extract-gms.csx" \
  --output="extracted/raw"
```

- **UndertaleModTool** : https://github.com/krzys-h/UndertaleModTool
- Decompile GML inclus
- Sortie : `extracted/raw/scripts/*.gml`, `extracted/raw/objects/*.json`, etc.

### Plan B — UndertaleModTool GUI

Mode interactif Windows pour extraire à la main quand le CLI bloque sur des
versions récentes de data.win.

### Plan C — gm-extractor (legacy)

- Pour les jeux GMS 1.x : https://github.com/donmccurdy/Game-Maker-Studio-2-Decompiler
- Plus limité mais marche sur les très anciens builds

---

## `gms1` — GameMaker Studio 1.x

### Plan A — UndertaleModTool en mode legacy

Identique au plan A de gms2, le tool détecte automatiquement la version.

### Plan B/C

Idem gms2.

---

## `lua-love2d` — LÖVE 2D

### Plan A — unzip natif (les .love SONT des zips)

```bash
unzip "<game>.love" -d extracted/raw
# Pas de decompilation — les .lua sont déjà au clair (sauf bytecode-only)
```

### Plan B — Lecture directe du dossier d'install

Si le jeu est shippé en mode "fused" (binaire LÖVE + assets dans un seul exe),
extraire avec :

```bash
# Le binaire LÖVE concatène le zip après l'exe → sed 7z fonctionne
7z x -y "<game>.exe" -o"extracted/raw"
```

### Plan C — luac listing

Si les `.lua` sont compilés en bytecode :

```bash
luac -l <file.lua> > <file.lua.bytecode-listing>
```

Information dégradée mais lisible.

---

## `electron` — Electron / Chromium

### Plan A — @electron/asar

```bash
npx @electron/asar extract "<game-dir>/resources/app.asar" extracted/raw
```

- Les sources JS et JSON sont accessibles directement après extraction
- Pas de décompilation nécessaire

### Plan B — Lecture directe de `resources/`

Si pas d'`app.asar`, le contenu de `resources/app/` est déjà au clair.

### Plan C — Browser DevTools

Mode debug : lancer le jeu avec `--inspect` et récupérer les sources via Chromium DevTools.
Manuel, pour les rares cas où l'asar est chiffré.

---

## `glaiel-engine` — Glaiel Game Engine (Mewgenics, The End Is Nigh)

Engine custom écrit par Tyler Glaiel (créé en 2010). Pas de Mono/.NET, pas de
Lua VM publique — moteur C++ propriétaire avec format archive `.gpak` et
format de data `.gon` (« Glaiel Object Notation », JSON-like custom).

**Signature dans le zip** : un seul fichier `resources.gpak` à côté de
`<Game>.exe`. Aucun signal `.dll` Mono/IL2CPP, pas de `.pck`, pas de
`.pak/.utoc`.

### Format `.gpak` (PKWARE-style mais maison)

Documenté par la communauté modding Mewgenics :

```
[u32 file_count]                               // ⚠ depuis v0.4.1 du tool seulement
repeat file_count times:
  [u16 name_length]
  [name_length × u8 name (UTF-8)]
  [u32 file_size]
... puis raw uncompressed file data dans le même ordre que les noms
```

Pas d'offsets stockés — tout est séquentiel. Pas de compression interne
(juste raw bytes), donc le `.gpak` fait à peu près la somme des assets.

### Plan A — `mewgenics_gpak_util` (Tiftid, Zig)

```bash
node datamine/_lib/install-tool.mjs mewgenics_gpak_util
./datamine/_lib/.tools/mewgenics_gpak_util/mewgenics_gpak_util.exe \
  unpack <path/to/resources.gpak> <output-dir>
```

Outil officiel-de-fait depuis 2026-02. Multi-plateforme (Win/Linux/macOS x64
+ ARM64). Bin pour Windows = `mewgenics_gpak_util.exe` (~0.6 MB).

**⚠ Pin v0.4.1 minimum** : la v0.4.1 « The revelation » corrige le bug du
header (les 4 premiers octets sont un `u32 file_count`, pas du padding —
versions antérieures décompressent des données indéfinies sur certains
assets).

### Plan B — `ShootMe/GPAK-Extractor` (.NET, drag & drop)

Pour Windows uniquement. Couvre aussi *The End Is Nigh*. Drag & drop le
fichier `.gpak` sur le `.exe` → dossier `Output/` créé à côté.

### Plan C — MewGPAKs (browser-based)

WebApp Steam Community guide. Manuel, pour debug ponctuel ou si les CLI
n'aboutissent pas.

### Décompilation du code (Phase 5 — obligatoire)

Engine C++ natif → décompil binaire **obligatoire** dès qu'une catégorie
wiki n'a pas de source dans la data extraite (ex: stats range, formules,
enums, magic numbers).

**Plan A — Ghidra batch headless** :
```bash
"<ghidra-install>/support/analyzeHeadless" \
  "<workspace>/extracted/decompiled" "<game-slug>-ghidra" \
  -import "<workspace>/zip-unpacked/<Game>/<Game>.exe" \
  -postScript ExportSymbolsAndStrings.java \
  -deleteProject
```
- Sortie : symboles + strings + pseudo-C des fonctions principales dans
  `extracted/decompiled/<game>.c`
- Temps typique : 15-60 min pour un exe ~20 MB stripped
- Cherche les structures `struct` qui matchent les modèles (ex: pour
  Mewgenics : `BaseStats { int strength; int dexterity; ... }`)

**Plan B — strings + triangulation 5-sources** :

Si Ghidra n'est pas dispo (~ 1 GB JDK + Ghidra + 30 min install), `strings`
+ profiling .gon donne souvent un résultat équivalent en 2 min. **MAIS** :
ne te contente pas du premier set évident — la première itération peut
manquer 30-50 % des stats. Utilise les 5 sources concordantes :

1. **Strings exhaustives** (sur Win sans `strings.exe`, Python suffit) :
   ```python
   import re
   data = open("Mewgenics.exe","rb").read()
   ascii_strs = re.findall(rb'[\x20-\x7e]{6,}', data)
   utf16_strs = re.findall(rb'(?:[\x20-\x7e]\x00){6,}', data)
   ```

2. **6 patterns BuffSystem** — pour engines avec stat-buff explicites :
   ```python
   for pat_name, pat in [
       ("Permanent<X>",   r"^Permanent([A-Z][a-zA-Z]+)$"),
       ("Temp<X>Up",      r"^Temp([A-Z][a-zA-Z]+)Up$"),
       ("Brittle<X>Up",   r"^Brittle([A-Z][a-zA-Z]+)Up$"),
       ("Add<X>",         r"^Add([A-Z][a-zA-Z]+)$"),
       ("<X>Up$",         r"^([A-Z][a-zA-Z]+)Up$"),
       ("<X>Down$",       r"^([A-Z][a-zA-Z]+)Down$"),
   ]: ...
   ```
   Une stat exposée au joueur a quasiment toujours `KEYWORD_<X>UP/DOWN` +
   au moins 2 des 6 patterns ci-dessus.

3. **Profiling .gon properties** — toutes les properties numériques avec
   leur fréquence d'apparition. Trie par occurrence : ce qui revient
   dans 300+ records = stat. Ce qui revient dans <50 = ressource locale
   (mana, initiative).

4. **`keyword_tooltips.gon`** (ou équivalent côté tooltips) — la déf
   canonique des keywords UI.

5. **CSV i18n** (`combined.csv` chez Glaiel, équivalent ailleurs) — les
   clés `KEYWORD_<X>_NAME` et `KEYWORD_<X>UP_NAME` confirment l'exposition
   au joueur.

**Règle d'inclusion** : retiens la stat dans la table `stats` si elle est
présente dans **≥ 4 sources sur 5**. Si elle apparaît juste dans les .gon
properties (ex: `mana`, `initiative` chez Mewgenics) sans buff system
parallèle ni KEYWORD i18n, c'est une **ressource** ou propriété interne,
pas une stat de personnage — laisse-la dans le payload des characters.

**Anti-pattern à éviter** : « j'ai trouvé Strength/Dex/Speed/Luck dans le
binaire, je m'arrête ». Mewgenics a en réalité 8 combat stats (les 4
classiques + Constitution/Intelligence/Charisma/Movement) — l'arrêt
prématuré rate ~50 % du contenu.

**Plan C — IDA Free** :
Pour les cas où Ghidra ne sort rien d'utile (binaire packed/obfusqué).
Hors scope du pipeline automatique → escalade à l'utilisateur.

**À retenir** : la donnée hard-codée dans l'engine **est extractible**.
Si la décompil sort 0 candidat utile, documente la tentative dans
`manifest.json.engine_detection.decompil_attempts` AVANT de marquer une
catégorie wiki comme "non extraite — décompil tentée sans succès".

### Format `.gon` (data files)

Format JSON-like inventé par Glaiel : voir https://github.com/TylerGlaiel/GON
pour le parser officiel C++. Caractéristiques :
- pas de virgules entre les champs
- pas de quotes obligatoires sur les keys
- whitespace-significant
- supporte commentaires `//` et `/* */`

Pour parser en Python/TS, il existe `pygon` (Python) ou ré-implémenter le
spec (~150 lignes — Phase 7 LLM-assisted).

### Format `.lua` (game logic)

Lua plain-text, lisible directement. Cherche les `define_*` et tables
globales pour identifier cards/items/cats/etc.

---

## `native` — Engine custom / inconnu (fallback générique)

### Plan A — strings + glob assets

```bash
# Extraction de strings depuis l'exe et les DLLs
strings -a -n 8 "<game-dir>/<Game>.exe" > extracted/raw/strings/<game>.txt

# Glob des images, configs, sons
node datamine/_lib/shallow-extract.mjs "<game-dir>"
```

→ Voir `38.9 — Mode shallow extraction` pour les détails.

### Plan B — Ghidra auto-analysis

- **Ghidra** : https://github.com/NationalSecurityAgency/ghidra
- Mode batch : `analyzeHeadless <project-dir> <project-name> -import <game.exe>`
- Sortie : DataTypes exportables en C-headers

### Plan C — IDA Free

- Pour reverse-engineering avancé manuel
- Hors scope du pipeline automatique — escalade à l'utilisateur

---

## Décision plan A → B → C dans le skill

Le skill `/datamine` exécute en Phase 4/5 :

1. Tente plan A (commande exacte selon engine)
2. Vérifie via `validate-extraction.mjs` (38.11)
3. Si validation KO → tente plan B → re-valide
4. Si plan B KO → tente plan C → re-valide
5. Si plan C KO → bascule en mode shallow (38.9) + log dans `manifest.json`

Cette logique garantit qu'on **ne reste jamais bloqué** : il y a toujours une
sortie, même dégradée.

---

## Ajouter un nouvel engine

1. Ajouter une entrée dans `engine-fingerprints.json`
2. Ajouter une section dans ce document avec plans A/B/C
3. Ajouter les outils dans `tool-registry.json` avec checksums
4. Ajouter les règles dans `validation-rules.json`
5. Tester `node datamine/_lib/detect-engine.mjs <zip-test>` doit retourner le bon engine

---

## Pièges connus — Cookbook (issu du run STS2 v0.103.2)

### Zip method 93 = Zstandard (pas Deflate64)

`unzip` Info-ZIP plante avec "unsupported compression method 93". Ce n'est PAS
Deflate64 (qui est méthode 9). C'est **Zstandard** (PKWARE APPNOTE 6.3.7).
Typique des zips AnkerGames récents et des dépôts qui upgrade leurs outils.

**Fix** : `extract-zip.mjs` détecte automatiquement et bascule sur
Python+`zstandard`. Si Python+zstandard manque : `pip install --user zstandard`.

### gdre_tools v0.6.2 ne supporte pas Pack version 3

GDRE Tools < v2.x lit uniquement les PCK Godot 4.0–4.2 (Pack v2). Tout PCK
Godot 4.3+ utilise Pack v3 et plante avec "Pack version unsupported: 3".

**Fix** : `tool-registry.json` pin **v2.4.0** (sortie 2025-12-27). Pour les
futures versions Godot (4.6+ → potentiellement Pack v4), basculer sur la
dernière release stable via `install-tool.mjs gdre_tools --use-latest`.

### gdre_tools v2.x : syntaxe `--key=value` (avec `=`)

L'usage standard `--key value` (avec espace) est silencieusement ignoré et
GDRE imprime son aide à la place. Toujours utiliser `--key=value`.

**Commande qui marche** : `gdre_tools --headless --recover="path.pck" --output-dir="out"`

### ilspycmd 8.x demande .NET 6 runtime (legacy)

ilspycmd 8.2.0 et antérieurs ciblent `Microsoft.NETCore.App 6.0.0` qui est
end-of-life depuis nov 2024. Sur un poste avec uniquement .NET 8 SDK, l'outil
plante au runtime.

**Fix** : pinner **9.1.0.7988** (cible .NET 8 nativement). `10.0.0.8330` est
publié sur NuGet mais cassé (`DotnetToolSettings.xml` manquant).

### drizzle-kit + NodeNext (optional postgres adapter only)

Le pattern `import { user } from '../schema.js'` (NodeNext-conforme) plante
drizzle-kit en mode CJS avec `Cannot find module '../schema.js'`.

**Fix actuel** : DDL inline dans le seeder (`CREATE SCHEMA + CREATE TABLE IF NOT EXISTS`)
via `adapters/postgres-seed.ts:applyDDL()`. Le schéma TS Drizzle reste utile comme source
de vérité des types pour l'éditeur.

**Fix futur** (à investiguer) : configurer drizzle-kit pour utiliser tsx loader
en mode ESM, ou bumper drizzle-kit à une version qui supporte NodeNext nativement.

### Drizzle expand JS arrays en tuples SQL

`sql\`${arrayJs}::TEXT[]\`` produit `($1, $2, $3, ...)::TEXT[]` (cast row→array,
invalide) au lieu de `'{a,b,c}'::TEXT[]` (literal array).

**Fix** : pour les colonnes TEXT[], pré-encoder en literal Postgres.
`adapters/postgres-seed.ts:bulkUpsert()` le fait automatiquement quand la colonne est
dans `textArrayColumns` (auto-détecté depuis le DDL).

### Strings scalaires dans colonnes JSONB

Une colonne JSONB qui reçoit `"cards"` (string nu) plante avec
`invalid input syntax for type json: Token "cards" is invalid`. JSON exige
`'"cards"'` (avec quotes JSON).

**Fix** : `adapters/postgres-seed.ts:bulkUpsert()` json-stringify TOUTE valeur destinée
à une colonne JSONB (auto-détectée), peu importe le type JS d'origine.

### Date JS pas acceptée par postgres-js via Drizzle template

`sql\`VALUES (..., ${dateObject}, ...)\`` plante avec
`The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received an instance of Date`.

**Fix** : `adapters/postgres-seed.ts:bulkUpsert()` convertit automatiquement les `Date`
en `${date.toISOString()}::TIMESTAMP`.

### Postgres array literal — règles d'échappement

Pour `'{a,b,c}'::TEXT[]` :
- pas d'espaces non-échappés dans les valeurs
- `"` à doubler en `\"`
- `\` à doubler en `\\`
- éléments avec virgules ou caractères spéciaux à entourer de `"..."`

**Fix** : helper d'escape inclus dans `adapters/postgres-seed.ts:bulkUpsert()`.

### Zips > 2 GiB : `readFileSync` plafonne à `kIoMaxLength`

Sur les zips de jeu volumineux (Mewgenics-AnkerGames.zip = 4.36 GB), la
première version de `probeZip()` plantait avec
`File size (XXX) is greater than 2 GiB`. Cause : Node.js limite
`fs.readFileSync` à `kIoMaxLength = 2³¹ - 1 octets` (≈ 2 GiB), héritage du
`ssize_t` de `read(2)` sur certaines plateformes — indépendant de
`buffer.constants.MAX_LENGTH` (qui est ~8 PiB sur 64-bit).

**Fix appliqué dans `extract-zip.mjs`** : `probeZip` n'utilise plus
`readFileSync` mais `openSync` + `readSync` ciblés sur les régions
nécessaires :
1. Queue de 65557 octets pour localiser EOCD
2. 56 octets pour EOCD64 si ZIP64 sentinel détecté
3. `cdSize` octets pour le Central Directory complet (borné à 1.5 GB par
   safety, en pratique < 100 MB pour des zips réels)

Helper `readRange(fd, position, length)` qui boucle sur `readSync` au cas où
celui-ci retourne moins d'octets que demandé (cas qui apparaît justement sur
les fichiers > 2 GiB selon la plateforme).

Ne touche pas la logique d'extraction réelle (déléguée à unzip/python/7z/winrar
qui n'ont pas cette limite).
