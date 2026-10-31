# Empaquetage — état réel au 31/10/2026

Ce document dit ce qui **marche vraiment** sur cette machine, ce qui bloque, et comment contourner.

## Vérifications rapides

```bash
npm run build        # typecheck + electron-vite build + copie de l'icône vers out/
npm test             # 890 passed / 1 skipped
```

## L'installeur : FAIT

```powershell
# Terminal PowerShell EN ADMINISTRATEUR (voir « Pourquoi » plus bas)
cd C:\Users\Dream\Downloads\Benten
npm run build:win
```

Produit dans `release/` :

| Fichier | Taille | Rôle |
| --- | --- | --- |
| `Benten Setup 0.1.0.exe` | 238 Mo | installeur NSIS (portée utilisateur) |
| `Benten 0.1.0 Portable.exe` | 237 Mo | version portable, sans installation |
| `win-unpacked/` | — | arborescence brute |

### Installation vérifiée

```powershell
release\Benten Setup 0.1.0.exe /S      # silencieux : code de sortie 0
```

- installe dans `%LOCALAPPDATA%\Programs\Benten` ;
- crée `Uninstall Benten.exe` ;
- crée l'entrée « Benten 0.1.0 » dans Paramètres ▸ Applications installées ;
- l'app installée démarre et affiche la bibliothèque.

> Piège de dépannage : l'entrée **officielle** de désinstallation a un GUID comme nom de clé et
> **pas** de champ `InstallLocation` — elle porte `UninstallString`. La supprimer casse
> « Applications installées » ; il faut alors réinstaller pour la recréer. Ne pas la confondre avec
> une entrée orpheline créée à la main lors des installations par copie.

## Pourquoi un terminal administrateur

`electron-builder` extrait `winCodeSign`, dont l'archive contient des **liens symboliques**
(`darwin/10.12/lib/libcrypto.dylib`). Windows refuse leur création sans :

- le **Mode développeur** (Paramètres ▸ Système ▸ Pour les développeurs), ou
- un jeton **administrateur**.

Sans l'un des deux : `ERROR: Cannot create symbolic link …`. Ce n'est pas un bug du projet.

## Identité de l'application

- icône : `build/icon.ico`, copiée dans `out/` par `scripts/copy-icon.mjs` (étape de `npm run build`) ;
- `app.setAppUserModelId("com.benten.player")` — sans lui, la barre des tâches rattache l'app à
  Electron (regroupement, notifications) ;
- métadonnées de l'exe : `ProductName`, `FileDescription`, `CompanyName`, version. `electron-builder`
  les remplit depuis `package.json` (`author`, `version`) ; `scripts/stamp-exe.mjs` permet de les
  corriger sur une installation existante sans reconstruire.

## Signature

L'installeur n'est **pas signé** (aucun certificat de signature de code ici). Conséquence :
SmartScreen affiche un avertissement au premier lancement (« Informations complémentaires » ▸
« Exécuter quand même »). Signer exige un certificat délivré à une entité, pas un réglage.

## Ce qui reste bloqué

- **Signature** : certificat à acheter.
- **Mise à jour automatique** : `electron-builder` peut produire `latest.yml`, mais il faut un
  hébergement ; non branché.
