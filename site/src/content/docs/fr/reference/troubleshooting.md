---
title: Dépannage
description: Solutions aux problèmes courants de déploiement, de l'application de bureau, de l'application mobile, de la téléphonie et des opérations cryptographiques.
---

Ce guide couvre les problèmes courants et leurs solutions pour tous les modes de déploiement et plateformes Llamenos.

## Problèmes de déploiement Docker

### Les conteneurs ne démarrent pas

**Variables d'environnement manquantes :**

Docker Compose valide tous les services au démarrage, même ceux avec profil. Si vous voyez des erreurs concernant des variables manquantes, assurez-vous que votre fichier `.env` inclut toutes les valeurs requises :

```bash
# Requis dans .env pour Docker Compose
PG_PASSWORD=your_postgres_password
STORAGE_ACCESS_KEY=your_rustfs_access_key
STORAGE_SECRET_KEY=your_rustfs_secret_key
HMAC_SECRET=your_hmac_secret
ARI_PASSWORD=your_ari_password       # Requis même si vous n'utilisez pas Asterisk
BRIDGE_SECRET=your_bridge_secret     # Requis même si vous n'utilisez pas Asterisk
ADMIN_PUBKEY=your_admin_hex_pubkey
```

Même si vous n'utilisez pas le bridge Asterisk, Docker Compose valide sa définition de service et exige que `ARI_PASSWORD` et `BRIDGE_SECRET` soient définis.

**Conflits de ports :**

Si un port est déjà utilisé, vérifiez quel processus l'occupe :

```bash
# Vérifier ce qui utilise le port 8787 (Worker)
sudo lsof -i :8787

# Vérifier ce qui utilise le port 5432 (PostgreSQL)
sudo lsof -i :5432

# Vérifier ce qui utilise le port 9000 (RustFS)
sudo lsof -i :9000
```

Arrêtez le processus en conflit ou changez le mapping de port dans `docker-compose.yml`.

### Erreurs de connexion à la base de données

Si l'application ne peut pas se connecter à PostgreSQL :

- Vérifiez que `PG_PASSWORD` dans `.env` correspond à ce qui a été utilisé lors de la première création du conteneur
- Vérifiez que le conteneur PostgreSQL est sain : `docker compose ps`
- Si le mot de passe a été changé, vous devrez peut-être supprimer le volume et recréer : `docker compose down -v && docker compose up -d`

### Le relais WebSocket relay ne se connecte pas

Le relais WebSocket est un service principal, pas optionnel. Si le relais ne fonctionne pas :

```bash
# Vérifier le statut du relais
docker compose logs WebSocket relay

# Redémarrer le relais
docker compose restart WebSocket relay
```

Si le relais ne démarre pas, vérifiez les conflits sur le port 7777 ou les permissions insuffisantes sur le répertoire de données.

### Erreurs de stockage RustFS / S3

- Vérifiez que `STORAGE_ACCESS_KEY` et `STORAGE_SECRET_KEY` sont corrects
- Vérifiez que le conteneur RustFS fonctionne : `docker compose ps rustfs`
- Accédez à la console RustFS sur `http://localhost:9001` pour vérifier la création du bucket

## Problèmes de déploiement Cloudflare

### Erreurs Durable Object

**« Durable Object not found » ou erreurs de binding :**

- Exécutez `bun run deploy` (jamais `wrangler deploy` directement) pour assurer des bindings DO corrects
- Vérifiez `wrangler.jsonc` pour les noms de classes DO et les bindings corrects
- Après l'ajout d'un nouveau DO, vous devez déployer avant qu'il ne soit disponible

**Limites de stockage DO :**

Les Cloudflare Durable Objects ont une limite de 128 Ko par paire clé-valeur. Si vous voyez des erreurs de stockage :

- Assurez-vous que le contenu des notes ne dépasse pas la limite (notes très volumineuses avec de nombreuses pièces jointes)
- Vérifiez que les enveloppes ECIES ne sont pas dupliquées

### Erreurs Worker (réponses 500)

Vérifiez les journaux du Worker :

```bash
bunx wrangler tail
```

Causes courantes :
- Secrets manquants (utilisez `bunx wrangler secret list` pour vérifier)
- Format `ADMIN_PUBKEY` incorrect (doit être 64 caractères hex, sans préfixe `npub`)
- Limitation de débit sur le tier gratuit (1 000 requêtes/minute sur Workers Free)

### Échec de déploiement avec les erreurs « Pages deploy »

N'exécutez jamais `wrangler pages deploy` ou `wrangler deploy` directement. Utilisez toujours les scripts racine de `package.json` :

```bash
bun run deploy          # Tout déployer (app + site marketing)
bun run deploy:site     # Déployer uniquement le site marketing
```

Exécuter `wrangler pages deploy dist` depuis le mauvais répertoire déploie le build Vite de l'app sur Pages au lieu du site Astro, cassant le site marketing avec des erreurs 404.

## Problèmes de l'application de bureau

### La mise à jour automatique ne fonctionne pas

L'application de bureau utilise le Tauri updater pour vérifier les nouvelles versions. Si les mises à jour ne sont pas détectées :

- Vérifiez votre connexion Internet
- Vérifiez que le endpoint de mise à jour est joignable : `https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- Sur Linux, l'AppImage de mise à jour automatique nécessite des droits d'écriture dans son répertoire
- Sur macOS, l'application doit être dans `/Applications` (ne pas l'exécuter directement depuis le DMG)

Pour mettre à jour manuellement, téléchargez la dernière version depuis la page [Téléchargements](/download).

### Échec du déverrouillage PIN

Si votre PIN est rejeté dans l'application de bureau :

- Assurez-vous de saisir le bon PIN (pas de récupération « PIN oublié »)
- Les PIN sont sensibles à la casse s'ils contiennent des lettres
- Si vous avez oublié votre PIN, vous devez re-saisir votre nsec pour en définir un nouveau. Vos notes chiffrées restent accessibles car elles sont liées à votre identité, pas à votre PIN
- Tauri Stronghold chiffre votre nsec avec une clé dérivée du PIN (PBKDF2). Un PIN incorrect produit un déchiffrement invalide, pas un message d'erreur — l'application détecte cela en vérifiant la clé publique dérivée

### Récupération de clé

Si vous perdez l'accès à votre appareil :

1. Utilisez votre nsec (que vous devriez stocker dans un gestionnaire de mots de passe) pour vous connecter sur un nouvel appareil
2. Si vous avez enregistré une clé d'accès WebAuthn, vous pouvez l'utiliser sur le nouvel appareil
3. Vos notes chiffrées sont stockées côté serveur — une fois connecté avec la même identité, vous pouvez les déchiffrer
4. Si vous avez perdu votre nsec et votre clé d'accès, contactez votre admin. Ils ne peuvent pas récupérer votre nsec, mais ils peuvent créer une nouvelle identité pour vous. Les notes chiffrées pour votre ancienne identité ne seront plus lisibles par vous

### L'application ne démarre pas (fenêtre vide)

- Vérifiez que votre système satisfait la configuration minimale requise (voir [Téléchargements](/download))
- Sur Linux, assurez-vous que WebKitGTK est installé : `sudo apt install libwebkit2gtk-4.1-0` (Debian/Ubuntu) ou équivalent
- Essayez de lancer depuis le terminal pour voir les erreurs : `./llamenos` (AppImage) ou vérifiez les journaux système
- Sous Wayland, essayez avec `GDK_BACKEND=x11` comme solution de secours

### Conflit d'instance unique

Llamenos impose le mode instance unique. Si l'application dit qu'elle fonctionne déjà mais que vous ne trouvez pas la fenêtre :

- Vérifiez les processus en arrière-plan : `ps aux | grep llamenos`
- Terminez les processus orphelins : `pkill llamenos`
- Sur Linux, vérifiez s'il existe un fichier de verrouillage obsolète et supprimez-le si l'application a planté

## Problèmes de l'application mobile

### Échecs d'approvisionnement

Voir le [Guide mobile](/docs/mobile-guide#troubleshooting-mobile-issues) pour le dépannage détaillé de l'approvisionnement.

Causes courantes :
- Code QR expiré (les tokens expirent après 5 minutes)
- Pas de connexion Internet sur l'un des appareils
- Versions de protocole différentes entre l'application de bureau et l'application mobile

### Les notifications push n'arrivent pas

- Vérifiez que les permissions de notification sont accordées dans les paramètres OS
- Sur Android, vérifiez que l'optimisation de la batterie ne tue pas l'application en arrière-plan
- Sur iOS, vérifiez que l'actualisation en arrière-plan est activée pour Llamenos
- Vérifiez que vous avez un quart actif et que vous n'êtes pas en pause

## Problèmes de téléphonie

### Configuration webhook Twilio

Si les appels ne sont pas routés vers les bénévoles :

1. Vérifiez les URLs de webhook dans la console Twilio :
   - Voice webhook : `https://your-worker.your-domain.com/telephony/incoming` (POST)
   - Status callback : `https://your-worker.your-domain.com/telephony/status` (POST)
2. Vérifiez que les identifiants Twilio dans vos paramètres correspondent à la console :
   - Account SID
   - Auth Token
   - Numéro de téléphone (doit inclure le code pays, ex. `+1234567890`)
3. Vérifiez le débogueur Twilio pour les erreurs : [twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### Configuration du numéro

- Le numéro de téléphone doit être un numéro Twilio ou un Caller ID vérifié
- Pour le développement local, utilisez un Cloudflare Tunnel ou ngrok pour exposer votre Worker local à Twilio
- Vérifiez que la configuration Voix du numéro pointe vers votre URL de webhook, pas le TwiML Bin par défaut

### Les appels se connectent mais pas d'audio

- Assurez-vous que le serveur média du fournisseur de téléphonie peut atteindre le téléphone du bénévole
- Vérifiez les problèmes NAT/pare-feu bloquant le trafic RTP
- Si vous utilisez WebRTC, vérifiez que les serveurs STUN/TURN sont correctement configurés
- Certains VPN bloquent le trafic VoIP — essayez sans VPN

### Les messages SMS/WhatsApp n'arrivent pas

- Vérifiez que les URLs de webhook de messagerie sont correctement configurées dans la console de votre fournisseur
- Pour WhatsApp, assurez-vous que le token de vérification webhook Meta correspond à vos paramètres
- Vérifiez que le canal de messagerie est activé dans **Paramètres admin > Canaux**
- Pour Signal, vérifiez que le bridge signal-cli fonctionne et est configuré pour transmettre à votre webhook

## Erreurs cryptographiques

### Erreurs de non-correspondance de clés

**« Échec du déchiffrement » ou « Clé invalide » à l'ouverture des notes :**

- Cela signifie généralement que la note a été chiffrée pour une identité différente de celle avec laquelle vous êtes connecté
- Vérifiez que vous utilisez le bon nsec (vérifiez que votre npub dans les Paramètres correspond à ce que l'admin voit)
- Si vous avez recréé votre identité récemment, les anciennes notes chiffrées pour votre ancienne clé publique ne seront pas déchiffrables avec la nouvelle clé

**« Signature invalide » à la connexion :**

- Le nsec est peut-être corrompu — réessayez en le collant depuis votre gestionnaire de mots de passe
- Assurez-vous que le nsec complet est collé (commence par `nsec1`, 63 caractères au total)
- Vérifiez qu'il n'y a pas d'espaces ou de caractères de retour à la ligne supplémentaires

### Échec de vérification de signature

Si les événements hub échouent à la vérification de signature :

- Vérifiez que l'horloge système est synchronisée (NTP). Un décalage important peut causer des problèmes avec les horodatages des événements
- Vérifiez que le relais WebSocket ne relaie pas d'événements provenant de clés publiques inconnues
- Redémarrez l'application pour récupérer la liste actuelle des membres du hub

### Erreurs d'enveloppe ECIES

**« Échec du développement de la clé » lors du déchiffrement des notes :**

- L'enveloppe ECIES a peut-être été créée avec une clé publique incorrecte
- Cela peut se produire si l'admin a ajouté un bénévole avec une erreur de frappe dans la clé publique
- L'admin devrait vérifier la clé publique du bénévole et ré-inviter si nécessaire

**« Longueur du texte chiffré invalide » :**

- Cela indique une corruption de données, possiblement due à une réponse réseau tronquée
- Réessayez l'opération. Si le problème persiste, les données chiffrées pourraient être définitivement corrompues
- Vérifiez les problèmes de proxy ou CDN qui pourraient tronquer les corps de réponse

### Erreurs de clé hub

**« Échec du déchiffrement de l'événement hub » :**

- La clé hub a peut-être été renouvelée depuis votre dernière connexion
- Fermez et rouvrez l'application pour récupérer la dernière clé hub
- Si vous avez été récemment retiré puis rajouté au hub, la clé a pu être renouvelée pendant votre absence

## Obtenir de l'aide

Si votre problème n'est pas couvert ici :

- Consultez les [Issues GitHub](https://github.com/rhonda-rodododo/llamenos-platform/issues) pour les bugs connus et les solutions de contournement
- Recherchez les issues existantes avant d'en créer une nouvelle
- Lors d'un rapport de bug, incluez : mode de déploiement (Cloudflare/Docker/Kubernetes), plateforme (Bureau/Mobile) et les messages d'erreur de la console du navigateur ou du terminal
