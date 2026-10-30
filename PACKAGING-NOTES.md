# Empaquetage — état réel au 30/10/2026

Ce document remplace les notes théoriques : il dit ce qui **marche vraiment** sur la machine de
l'utilisateur, ce qui bloque, et comment contourner.

## Ce qui marche

```bash
npm run build      # typecheck + electron-vite build (main, preload, renderer)
npm test           # 796 passed / 1 skipped
```

Ces deux commandes sont les portes de sortie : elles doivent rester vertes avant tout paquet.

## Ce qui ne marche pas : `electron-builder`

`npm run pack:dir` et `npm run build:win` échouent sur cette machine :

```
ERROR: Cannot create symbolic link :
  C:\Users\Dream\AppData\Local\electron-builder\Cache\winCodeSign\<id>\darwin\10.12\lib\libcrypto.dylib
ERROR: Cannot create symbolic link : ... libssl.dylib
```

electron-builder extrait le paquet `winCodeSign` (utile à la signature) qui contient des **liens
symboliques macOS**. Windows refuse de les créer sans privilège élevé ou sans le *Mode développeur*
activé. Ce n'est pas un problème du projet : c'est un droit du compte utilisateur.

### Débloquer (une fois)

- Paramètres → Confidentialité et sécurité → Pour les développeurs → **Mode développeur : activé**,
  puis relancer `npm run pack:dir` ; **ou**
- lancer la commande depuis un terminal **administrateur**.

Aucune donnée du projet n'est concernée : seul le cache d'outils d'electron-builder est en cause.

## Contournement utilisé pour livrer une version lançable

Tant que le mode développeur est désactivé, l'app est reconstruite à la main dans le
`release/win-unpacked` existant :

1. `npx electron-vite build` (produit `out/`).
2. Assembler une archive applicative contenant `out/`, `package.json` **et les dépendances
   runtime** — un `app.asar` sans `node_modules` démarre puis se ferme aussitôt, `better-sqlite3`
   étant requis par le processus principal :
   ```bash
   npm ls --omit=dev --all --parseable   # liste des dépendances à recopier
   ```
3. `better-sqlite3` reste **dépaqueté** (`release/win-unpacked/resources/app.asar.unpacked`) :
   un addon natif ne peut pas être chargé depuis une archive.
4. Repaqueter :
   ```bash
   node -e "require('@electron/asar').createPackage('<dossier>', 'release/win-unpacked/resources/app.asar')"
   ```
5. Copier `build/icon.ico` dans `out/` : l'icône de fenêtre est lue depuis `join(__dirname, '..', 'icon.ico')`.

**Limite de ce contournement :** l'exe garde son ancienne **ressource d'icône** (celle embarquée
dans le binaire). L'icône de fenêtre et de barre des tâches, elle, est bien la nouvelle, puisqu'elle
est chargée à l'exécution.

## Installation par utilisateur (sans administrateur)

Comme `electron-builder` reste bloqué (voir plus bas), l''app est installée **par utilisateur**,
sans élévation — c''est un vrai emplacement d''installation Windows, pas un dossier de compilation :

| Élément | Chemin |
| --- | --- |
| Application installée | `%LOCALAPPDATA%\Programs\Benten\` |
| Menu Démarrer | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Benten.lnk` |
| Bureau | `Benten.lnk` |
| Désinstallation | Paramètres → Applications → Benten (entrée `HKCU\...\Uninstall\Benten`) |

Mettre à jour = recopier le contenu de `release/win-unpacked` (ou l''asar reconstruit) dans
`%LOCALAPPDATA%\Programs\Benten\`, app fermée.

## Où vit l''app installée (31/10/2026)

L'app utilisée au quotidien est **copiée hors du dossier de compilation**, dans un emplacement
stable, avec un raccourci sur le Bureau :

| Élément | Chemin |
| --- | --- |
| Application | `C:\Users\Dream\Apps\Benten\` |
| Exécutable | `C:\Users\Dream\Apps\Benten\Benten.exe` |
| Raccourci | Bureau → `Benten.lnk` |
| Données | `%APPDATA%\benten\` (base, cache de pochettes, cookies, yt-dlp) |
| Téléchargements | `%USERPROFILE%\Music\Benten\{YouTube,Apple}` (ajoutés comme sources) |

Mettre à jour l'app = reconstruire `app.asar` dans `C:\Users\Dream\Apps\Benten\resources\`.
Le dossier `release/win-unpacked` n'est qu'une sortie de compilation : ne pas l'utiliser au
quotidien, il peut être écrasé au prochain build.

## Tailles et chemins (version actuelle)

| Élément | Chemin | Taille |
| --- | --- | --- |
| Exécutable | `release/win-unpacked/Benten.exe` | ~238 Mo |
| Archive applicative | `release/win-unpacked/resources/app.asar` | ~185 Mo |
| Ressources DA embarquées | dans l'asar (`out/renderer/assets`) | ~7 Mo |
| Base de données | `%APPDATA%/Benten/` | ~1 Mo pour 969 titres |
| Cache de pochettes | `%APPDATA%/Benten/art-cache` | ~42 Mo (784 fichiers) |

## Pochettes : 1024 px

La taille de cache des pochettes passe de 512 à **1024 px** (`DEFAULT_ART_SIZE`). Les grandes
tuiles vont jusqu'à ~420 px CSS, soit ~840 px en écran 2× : 512 y perdait en netteté.

Les entrées **déjà** en cache restent servies telles quelles (le cache ne se réécrit pas). Pour que
toute la bibliothèque en profite :

```powershell
Stop-Process -Name Benten -ErrorAction SilentlyContinue
Remove-Item "$env:APPDATA\Benten\art-cache" -Recurse -Force
```

Les pochettes sont alors ré-extraites à la première lecture, en 1024.

## Ce qu'il reste à faire quand le mode développeur sera actif

1. `npm run build:win` → produit l'installeur NSIS et la version **portable** (un seul `.exe`).
2. Vérifier que l'icône embarquée est la nouvelle (soleil d'or + torii), lisible à 16 px.
3. Noter ici les tailles finales des deux artefacts.


