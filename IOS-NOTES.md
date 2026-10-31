# Benten sur iPhone — trois chemins, un seul code

La même page (`mobile/`) sert aux deux formes : PWA installée depuis Safari, ou app `.ipa`
enveloppée par Capacitor. Une seule base de code, deux emballages.

## 1. PWA — disponible tout de suite, zéro maintenance

C'est ce qui tourne déjà. Aucune signature, aucune expiration.

1. iPhone sur le même Wi-Fi que le PC, Benten ouvert sur le PC.
2. Safari → `http://<ip-du-pc>:4321/` (l'adresse exacte est dans Réglages ▸ Benten sur iPhone).
3. Partager ▸ **Sur l'écran d'accueil**.

Après la première visite, le service worker garde l'app : elle s'ouvre **sans PC allumé**, et tes
morceaux vivent sur le téléphone (IndexedDB).

## 2. `.ipa` non signé — pour installer comme une vraie app

Construit **sans Mac**, sur les machines macOS de GitHub Actions.

```bash
# une seule fois : pousser le dépôt sur GitHub (compte gratuit)
git remote add origin https://github.com/<toi>/benten.git
git push -u origin main
```

Puis, sur GitHub : onglet **Actions** ▸ **iOS — ipa non signé** ▸ **Run workflow**.
L'artefact `benten-ios-ipa` contient `benten-unsigned.ipa` — à signer avec l'outil que tu utilises
déjà (AltStore, Sideloadly, ESign…).

### Durée de validité de la signature

| Méthode de signature | Durée |
| --- | --- |
| Apple ID gratuit | **7 jours** (à resigner chaque semaine) |
| Compte développeur Apple (99 €/an) | **1 an** |
| Certificat d'entreprise (service de signature) | jusqu'à révocation, souvent des mois |

Ce n'est pas une limite de Benten : c'est Apple qui décide, selon le certificat qui signe l'app.

## 3. Ce qu'aucune version iOS ne pourra faire

Ces deux limites viennent du système, pas du code :

- **scanner un dossier de musique** : le bac à sable iOS l'interdit à toute app ; les morceaux
  s'importent depuis Fichiers / iCloud ;
- **télécharger depuis Apple Music ou YouTube** : iOS interdit d'exécuter un programme externe
  (yt-dlp, ffmpeg). C'est le PC qui télécharge, et le téléphone récupère par la synchronisation.

## Synchronisation téléphone ↔ PC

Le PC sert la bibliothèque sur le réseau local, protégée par un jeton aléatoire affiché dans
**Réglages ▸ Benten sur iPhone ▸ Jeton**.

Sur le téléphone : **Réglages ▸ Synchroniser avec le PC**, saisir l'adresse et le jeton, puis
« Récupérer les nouveaux morceaux ». Seuls les morceaux absents du téléphone sont transférés.

API (jeton obligatoire, sinon 403) :

- `GET /api/library?token=…` → liste JSON des morceaux ;
- `GET /api/audio/<id>?token=…` → flux du fichier.
