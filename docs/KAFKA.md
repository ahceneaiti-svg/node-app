# Kafka : notifications par mail

À chaque création d'utilisateur (`POST /users`), l'API publie un événement dans Kafka ; le service `notifier` le consomme et envoie un mail de bienvenue.

```
POST /users ─► back-node ──(topic user-created)──► Kafka ──► notifier ──SMTP──► Mailpit
                  │                                  ▲
                  ▼                                  └── Kafka UI (inspection)
                MySQL
```

| Composant   | Rôle | Image | Accès |
|-------------|------|-------|-------|
| `kafka`     | broker unique, mode KRaft (sans ZooKeeper), StatefulSet + PVC 2 Gi | `apache/kafka:3.9.0` | interne `kafka:9092` |
| `kafka-ui`  | interface d'administration | `provectuslabs/kafka-ui:v0.7.2` | http://localhost:8090 |
| `mailpit`   | faux serveur SMTP qui capture les mails | `axllent/mailpit:v1.21` | UI http://localhost:8025, SMTP interne `mailpit:1025` |
| `notifier`  | consumer Kafka → envoi de mail (nodemailer) | `ahceneaiti/notifier:1.0` | aucun |

## Événement `user-created`

Topic `user-created` (3 partitions, créé automatiquement), clé = `id` utilisateur.

```json
{"id": 1, "name": "Alice", "email": "alice@example.com", "createdAt": "2026-10-12T08:53:42.000Z"}
```

Garanties et limites :

- Publication **asynchrone et non bloquante** : si Kafka est indisponible, l'utilisateur est quand même créé (erreur loguée par l'API, mail non envoyé).
- Le `notifier` ne commite l'offset qu'après l'envoi du mail : en cas d'échec SMTP le message est rejoué (**au moins une fois**, un doublon de mail est possible).
- Pas de pattern outbox : un crash de l'API entre l'écriture MySQL et la publication perd l'événement.
- Un seul broker, réplication 1 : adapté à la démo, pas à la production.

## Déployer

Voir [`../k8s/README.md`](../k8s/README.md#kafka-et-notifications). Résumé :

```bash
docker build -t ahceneaiti/back-node:1.1 back-node
docker build -t ahceneaiti/notifier:1.0 notifier
kind load docker-image ahceneaiti/back-node:1.1 ahceneaiti/notifier:1.0 --name users
kubectl apply -f k8s/kafka/
kubectl -n users-app rollout status sts/kafka
kubectl apply -f k8s/back-node.yaml
```

## Tester

```bash
curl -X POST localhost:8080/users -H 'Content-Type: application/json' \
  -d '{"name":"Alice","email":"alice@example.com"}'
```

Puis ouvrir http://localhost:8025 (mail reçu) et http://localhost:8090 → *Topics* → `user-created` → *Messages*.

## Exploiter avec Kafka UI

http://localhost:8090 (sans authentification : usage local uniquement).

- **Brokers** : état du broker, disque utilisé.
- **Topics** : partitions, messages (filtrer par offset/partition/clé), création, suppression, configuration (`retention.ms`...). *Produce Message* permet de publier un événement à la main.
- **Consumers** : groupe `notifier`, offset courant et **lag** par partition. Lag qui grossit = `notifier` arrêté ou bloqué.

Si l'UI n'est pas joignable (cluster créé sans le mapping kind) : `kubectl -n users-app port-forward svc/kafka-ui 8090:8080`. Idem Mailpit : `svc/mailpit 8025:8025`.

## Exploiter en ligne de commande

Les outils Kafka sont dans le pod `kafka-0` (`/opt/kafka/bin`). Le broker écoute sur `localhost:9092` depuis ce pod.

```bash
# raccourci : kk <outil.sh> <arguments...>
kk() { local t=$1; shift; kubectl -n users-app exec -i kafka-0 -- /opt/kafka/bin/$t --bootstrap-server localhost:9092 "$@"; }
```

Toutes les commandes ci-dessous utilisent `kk`. Sans le raccourci : `kubectl -n users-app exec -i kafka-0 -- /opt/kafka/bin/<outil>.sh --bootstrap-server localhost:9092 ...`.

### Topics

```bash
kk kafka-topics.sh --list
kk kafka-topics.sh --describe --topic user-created        # partitions, leader, réplicas, ISR
kk kafka-topics.sh --describe --under-replicated-partitions

kk kafka-topics.sh --create --topic autre --partitions 3 --replication-factor 1
kk kafka-topics.sh --alter --topic autre --partitions 6   # augmenter seulement, jamais réduire
kk kafka-topics.sh --delete --topic autre
```

Attention : augmenter les partitions change le routage des clés (même `id` → autre partition) pour les futurs messages.

### Lire les messages

```bash
# tout le topic (s'arrête après 5 s sans nouveau message)
kk kafka-console-consumer.sh --topic user-created --from-beginning --timeout-ms 5000

# avec clé, partition, offset et horodatage
kk kafka-console-consumer.sh --topic user-created --from-beginning --timeout-ms 5000 \
  --property print.key=true --property print.partition=true \
  --property print.offset=true --property print.timestamp=true

# une partition à partir d'un offset, 10 messages max
kk kafka-console-consumer.sh --topic user-created --partition 0 --offset 5 --max-messages 10

# suivre en direct (Ctrl+C pour quitter)
kk kafka-console-consumer.sh --topic user-created

# lecture sans toucher au groupe `notifier` : ne pas passer --group (groupe temporaire créé)
```

Mettre en forme le JSON (nécessite `jq` sur la machine hôte) :

```bash
kk kafka-console-consumer.sh --topic user-created --from-beginning --timeout-ms 5000 | jq .
```

### Publier un événement

Chaque ligne est un message. Un message valide déclenche un mail via le `notifier`.

```bash
echo '{"id":99,"name":"Test","email":"test@example.com"}' | kk kafka-console-producer.sh --topic user-created

# avec une clé (même clé = même partition)
echo '99:{"id":99,"name":"Test","email":"test@example.com"}' | \
  kk kafka-console-producer.sh --topic user-created --property parse.key=true --property key.separator=:
```

Un message invalide (JSON cassé, `email` absent) est ignoré et loggué par le `notifier`, sans bloquer la suite.

### Offsets et taille des topics

```bash
# nombre de messages par partition (--time -1 = fin, -2 = début) ; messages = fin - début
kk kafka-get-offsets.sh --topic user-created --time -1
kk kafka-get-offsets.sh --topic user-created --time -2

# espace disque par topic/partition
kk kafka-log-dirs.sh --describe --topic-list user-created
```

### Groupes de consumers

```bash
kk kafka-consumer-groups.sh --list
kk kafka-consumer-groups.sh --describe --group notifier   # CURRENT-OFFSET, LOG-END-OFFSET, LAG par partition
kk kafka-consumer-groups.sh --describe --group notifier --members --verbose
kk kafka-consumer-groups.sh --describe --group notifier --state
```

Un `LAG` qui reste supérieur à 0 signifie que le `notifier` n'a pas fini de traiter les messages.

**Repositionner le groupe** (le `notifier` doit être arrêté : `kubectl -n users-app scale deploy/notifier --replicas=0`). Toujours lancer d'abord avec `--dry-run`, puis `--execute`.

```bash
G="--group notifier --topic user-created"
kk kafka-consumer-groups.sh --reset-offsets $G --to-earliest --dry-run   # rejoue tout (un mail par message !)
kk kafka-consumer-groups.sh --reset-offsets $G --to-latest   --execute   # ignore les messages en attente
kk kafka-consumer-groups.sh --reset-offsets $G --shift-by -3  --execute  # recule de 3 par partition
kk kafka-consumer-groups.sh --reset-offsets $G --to-datetime 2026-10-12T08:00:00.000 --execute
kk kafka-consumer-groups.sh --delete --group notifier                    # supprime le groupe (offsets perdus)
```

Puis `kubectl -n users-app scale deploy/notifier --replicas=1`.

### Configuration

```bash
# configuration d'un topic
kk kafka-configs.sh --describe --entity-type topics --entity-name user-created
kk kafka-configs.sh --alter --entity-type topics --entity-name user-created --add-config retention.ms=86400000   # 1 jour
kk kafka-configs.sh --alter --entity-type topics --entity-name user-created --delete-config retention.ms

# configuration du broker (id 1)
kk kafka-configs.sh --describe --entity-type brokers --entity-name 1 --all
```

### État du cluster

```bash
kk kafka-broker-api-versions.sh | head -1                    # broker joignable + version
kubectl -n users-app exec kafka-0 -- /opt/kafka/bin/kafka-metadata-quorum.sh \
  --bootstrap-server localhost:9092 describe --status        # contrôleur KRaft, leader, epoch
```

### Test de charge

```bash
kk kafka-producer-perf-test.sh --topic perf --num-records 10000 --record-size 200 \
  --throughput -1 --producer-props bootstrap.servers=localhost:9092
kk kafka-topics.sh --delete --topic perf
```

Ne pas utiliser `user-created` pour ce test : le `notifier` enverrait des milliers de mails (illisibles et rejetés).

### Depuis la machine hôte (sans `exec`)

Le broker annonce son adresse interne (`kafka-0.kafka-headless...`) : un client hors cluster ne peut pas s'y connecter directement. Pour un accès hôte, utiliser Kafka UI ou `kubectl exec` comme ci-dessus.

## Opérations courantes

| Besoin | Commande |
|--------|----------|
| Logs du broker / du notifier / de l'API | `kubectl -n users-app logs kafka-0` · `deploy/notifier` · `deploy/back-node` |
| Rejouer tous les mails | arrêter le `notifier` puis `--reset-offsets --to-earliest` (voir *Groupes de consumers*) ; renvoie un mail par message conservé |
| Sauter les messages en attente | `--reset-offsets --to-latest --execute` (notifier à l'arrêt) |
| Paralléliser l'envoi | `kubectl -n users-app scale deploy/notifier --replicas=3` (max = nombre de partitions) |
| Rétention des messages | défaut 7 jours, modifiable avec `retention.ms` (voir *Configuration*) |
| Redémarrer Kafka | `kubectl -n users-app rollout restart sts/kafka` (données conservées sur le PVC `data-kafka-0`) |
| Tout effacer | `kubectl -n users-app delete sts/kafka pvc/data-kafka-0` |

## Dépannage

| Symptôme | Cause / action |
|----------|----------------|
| Pas de mail, `notifier` en erreur | `kubectl -n users-app logs deploy/notifier` ; vérifier `mailpit` Running |
| Lag qui grossit dans Kafka UI | `notifier` arrêté ou échec SMTP en boucle (le message est rejoué) |
| Log API `Événement non publié (Kafka indisponible)` | Kafka pas encore prêt ou arrêté ; l'utilisateur est créé mais le mail ne partira pas |
| `notifier` redémarre une fois au premier déploiement | coordinateur de groupe pas encore prêt au démarrage de Kafka, se résout seul |
| `kafka-0` en `CrashLoopBackOff` avec `KAFKA_PORT` | `enableServiceLinks: false` manquant dans le pod |
| Kafka UI : cluster `offline` | `kafka-0` non prêt ; l'advertised listener est `kafka-0.kafka-headless.users-app.svc.cluster.local:9092` |

## Passer en production

- Plusieurs brokers (3), `replication.factor=3`, `min.insync.replicas=2`, auth SASL/TLS.
- Protéger Kafka UI (auth OIDC/LDAP) ou ne pas l'exposer ; ne jamais laisser de NodePort ouvert.
- Remplacer Mailpit : variables `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` du `notifier`, avec les identifiants dans un Secret.
- Ajouter un pattern outbox si aucune perte d'événement n'est tolérée.
