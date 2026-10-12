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

Les outils sont dans le pod `kafka-0` :

```bash
K="kubectl -n users-app exec kafka-0 --"
B=/opt/kafka/bin

# topics
$K $B/kafka-topics.sh --bootstrap-server localhost:9092 --list
$K $B/kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic user-created
$K $B/kafka-topics.sh --bootstrap-server localhost:9092 --create --topic autre --partitions 3

# lire les messages
$K $B/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic user-created --from-beginning --timeout-ms 5000

# publier un événement à la main (déclenche un mail)
echo '{"id":99,"name":"Test","email":"test@example.com"}' | \
  kubectl -n users-app exec -i kafka-0 -- $B/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic user-created

# groupes de consumers et lag
$K $B/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --list
$K $B/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group notifier
```

## Opérations courantes

| Besoin | Commande |
|--------|----------|
| Logs du broker / du notifier / de l'API | `kubectl -n users-app logs kafka-0` · `deploy/notifier` · `deploy/back-node` |
| Rejouer tous les mails | supprimer le groupe puis redémarrer : `kubectl -n users-app scale deploy/notifier --replicas=0`, `$K $B/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --delete --group notifier`, `scale --replicas=1` (renvoie un mail par message conservé !) |
| Sauter les messages en attente | `kafka-consumer-groups.sh ... --group notifier --topic user-created --reset-offsets --to-latest --execute` (notifier à l'arrêt) |
| Paralléliser l'envoi | `kubectl -n users-app scale deploy/notifier --replicas=3` (max = nombre de partitions) |
| Rétention des messages | défaut 7 jours : `kafka-configs.sh --bootstrap-server localhost:9092 --alter --entity-type topics --entity-name user-created --add-config retention.ms=86400000` |
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
