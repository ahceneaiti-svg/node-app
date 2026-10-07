# mysql-operator

Opérateur Kubernetes (Node.js) qui gère un cluster MySQL **primaire + réplicas** avec réplication GTID, ainsi que les **sauvegardes** et **restaurations**. Il est utilisé par l'API `back-node` du repo.

- Image : `ahceneaiti/mysql-operator:1.0` (construite depuis `operator/`)
- API group : `mysql.ahceneaiti.dev/v1alpha1`
- Aucune dépendance Kubernetes : l'opérateur parle directement à l'API REST (server-side apply). Seule dépendance npm : `mysql2`.

## Sommaire

1. [Fonctionnalités](#fonctionnalités)
2. [Architecture](#architecture)
3. [Ressources personnalisées (CRD)](#ressources-personnalisées-crd)
4. [Installation](#installation)
5. [Utilisation](#utilisation)
6. [Fonctionnement détaillé](#fonctionnement-détaillé)
7. [RBAC](#rbac)
8. [Configuration de l'opérateur](#configuration-de-lopérateur)
9. [Développement local](#développement-local)
10. [Limites connues](#limites-connues)
11. [Dépannage](#dépannage)

## Fonctionnalités

| Fonction              | Détail |
|-----------------------|--------|
| Cluster MySQL         | StatefulSet MySQL 8.4 : `mysql-0` primaire, `mysql-1..N` réplicas |
| Réplication           | Asynchrone, GTID (`SOURCE_AUTO_POSITION=1`), configurée automatiquement |
| Protection des réplicas | `super_read_only=ON` réappliqué à chaque cycle |
| Services              | `<nom>` (primaire, écritures), `<nom>-read` (réplicas, lectures), `<nom>-headless` (DNS des pods) |
| Backup ponctuel       | CR `MySQLBackup` : `mysqldump` compressé sur un volume dédié |
| Backup planifié       | `spec.backup.schedule` (cron) avec rotation (`retention`) |
| Restore               | CR `MySQLRestore` : rejoue un backup sur le primaire, répliqué ensuite aux réplicas |
| Statut                | Phase, primaire, retard de réplication, erreurs, visibles via `kubectl get` |
| Auto-réparation       | Pod recréé, réplica supprimé ou scale : réplication reconfigurée automatiquement |

## Architecture

```
                    ┌──────────────────────────────────────────────┐
 kubectl apply ───► │ MySQLCluster / MySQLBackup / MySQLRestore    │
                    └──────────────────┬───────────────────────────┘
                                       │ liste toutes les 10 s
                              ┌────────▼────────┐
                              │ mysql-operator  │
                              └──┬───────────┬──┘
              server-side apply  │           │  SQL (root)
        ┌────────────────────────▼──┐     ┌──▼──────────────────────┐
        │ StatefulSet, Services,    │     │ CREATE USER repl,       │
        │ PVC, CronJob, Jobs,       │     │ CHANGE REPLICATION      │
        │ labels de rôle des pods   │     │ SOURCE, START REPLICA   │
        └───────────────────────────┘     └─────────────────────────┘

   Service mysql ──► mysql-0 (primaire) ──binlog GTID──► mysql-1..N (réplicas) ◄── Service mysql-read
                          ▲
   API back-node ─────────┘ (écritures et lectures)

   Volume <nom>-backups ◄── Jobs mysqldump (depuis un réplica sain, sinon le primaire)
                        ──► Job restore (vers le primaire)
```

### Ressources créées pour un `MySQLCluster` nommé `mysql`

| Ressource                 | Nom             | Remarque |
|---------------------------|-----------------|----------|
| Service headless          | `mysql-headless`| DNS stable `mysql-N.mysql-headless.<ns>.svc.cluster.local` |
| Service primaire          | `mysql`         | sélectionne le label `mysql.ahceneaiti.dev/role=primary` |
| Service lecture           | `mysql-read`    | sélectionne `role=replica` |
| StatefulSet               | `mysql`         | `1 + spec.replicas` pods, un PVC `data-mysql-N` par pod |
| PVC de backups            | `mysql-backups` | **non supprimé** avec le cluster |
| CronJob (si `schedule`)   | `mysql-backup`  | supprimé si `schedule` est retiré |

Tout sauf le PVC de backups porte une `ownerReference` vers le `MySQLCluster` : supprimer le CR supprime ces objets. Les PVC `data-mysql-N` du StatefulSet sont conservés par Kubernetes.

## Ressources personnalisées (CRD)

Définitions dans `deploy/crds.yaml`.

### MySQLCluster (`mc`)

```yaml
apiVersion: mysql.ahceneaiti.dev/v1alpha1
kind: MySQLCluster
metadata:
  name: mysql
  namespace: users-app
spec:
  replicas: 1            # réplicas en plus du primaire (0 à 5, défaut 1)
  image: mysql:8.4       # défaut mysql:8.4
  secretName: mysql-secret
  storage: 1Gi           # volume de chaque instance
  backup:
    schedule: "0 2 * * *"  # cron, vide = pas de backup planifié
    retention: 7           # nombre de backups planifiés conservés (défaut 7)
    storage: 2Gi           # taille du volume de backups (défaut 2Gi)
```

Le Secret `secretName` doit contenir :

| Clé                          | Usage |
|------------------------------|-------|
| `MYSQL_ROOT_PASSWORD`        | mot de passe root (opérateur, jobs, probes) |
| `MYSQL_REPLICATION_PASSWORD` | mot de passe de l'utilisateur `repl` |
| `MYSQL_DATABASE`             | base applicative créée sur le primaire et sauvegardée |
| `MYSQL_USER`, `MYSQL_PASSWORD` | utilisateur applicatif créé sur le primaire |

Statut (`kubectl get mc`) :

| Champ                 | Description |
|-----------------------|-------------|
| `status.phase`        | `Pending` (secret absent/incomplet), `Provisioning` (pods manquants ou non prêts), `Degraded` (un réplica ne réplique pas), `Ready` |
| `status.primary`      | pod primaire |
| `status.readyReplicas`| réplicas prêts et en réplication |
| `status.instances[]`  | par pod : `role`, `ready`, `replicating`, `lagSeconds`, `error` |

### MySQLBackup (`mb`)

```yaml
apiVersion: mysql.ahceneaiti.dev/v1alpha1
kind: MySQLBackup
metadata:
  name: backup-manuel-1
  namespace: users-app
spec:
  clusterName: mysql
```

Produit le fichier `/backups/<nom-du-CR>.sql.gz` sur le volume `<cluster>-backups`.
Statut : `phase` (`Running`, `Completed`, `Failed`), `file`, `jobName`, `startTime`, `completionTime`, `message`.
Un backup `Completed` ou `Failed` n'est plus retraité. Pour en refaire un, créer un nouveau CR.

### MySQLRestore (`mr`)

```yaml
apiVersion: mysql.ahceneaiti.dev/v1alpha1
kind: MySQLRestore
metadata:
  name: restore-manuel-1
  namespace: users-app
spec:
  clusterName: mysql
  backupName: backup-manuel-1   # un MySQLBackup terminé
  # file: scheduled-20261007-020000.sql.gz   # alternative : fichier du volume (backups planifiés)
```

Statut : `phase` (`Pending` en attente du backup, `Running`, `Completed`, `Failed`), `file`, `jobName`, `message`.

## Installation

Prérequis : cluster kind `users` créé avec `k8s/kind-config.yaml`, namespace `users-app`.

```bash
# 1. image de l'opérateur
docker build -t ahceneaiti/mysql-operator:1.0 operator
kind load docker-image ahceneaiti/mysql-operator:1.0 --name users
#   (ou : docker push ahceneaiti/mysql-operator:1.0 si l'image est publiée)

# 2. CRD (cluster-wide) puis namespace
kubectl apply -f operator/deploy/crds.yaml -f k8s/namespace.yaml

# 3. opérateur : RBAC + Deployment
kubectl apply -f operator/deploy/rbac.yaml -f operator/deploy/operator.yaml

# 4. secret + cluster MySQL
kubectl apply -f k8s/secret.yaml -f k8s/mysql-cluster.yaml
kubectl -n users-app wait --for=jsonpath='{.status.phase}'=Ready mysqlcluster/mysql --timeout=300s
```

## Utilisation

```bash
# État
kubectl -n users-app get mysqlcluster,mysqlbackup,mysqlrestore
kubectl -n users-app get mc mysql -o jsonpath='{.status.instances}'

# Scaler les réplicas
kubectl -n users-app patch mc mysql --type merge -p '{"spec":{"replicas":2}}'

# Backup ponctuel
kubectl apply -f k8s/examples/backup.yaml
kubectl -n users-app wait --for=jsonpath='{.status.phase}'=Completed mysqlbackup/backup-manuel-1 --timeout=120s

# Restore
kubectl apply -f k8s/examples/restore.yaml
kubectl -n users-app wait --for=jsonpath='{.status.phase}'=Completed mysqlrestore/restore-manuel-1 --timeout=120s

# Lancer immédiatement le backup planifié
kubectl -n users-app create job --from=cronjob/mysql-backup backup-now

# Lister les fichiers de backup (pod temporaire montant le volume)
kubectl -n users-app run ls-backups --restart=Never --image=mysql:8.4 \
  --overrides='{"spec":{"containers":[{"name":"ls","image":"mysql:8.4","command":["ls","-lh","/backups"],"volumeMounts":[{"name":"b","mountPath":"/backups"}]}],"volumes":[{"name":"b","persistentVolumeClaim":{"claimName":"mysql-backups"}}]}}'
kubectl -n users-app wait --for=jsonpath='{.status.phase}'=Succeeded pod/ls-backups --timeout=60s
kubectl -n users-app logs ls-backups && kubectl -n users-app delete pod ls-backups
```

Vérifier la réplication à la main :

```bash
kubectl -n users-app exec mysql-1 -- mysql -uroot -prootpassword -e "SHOW REPLICA STATUS\G" | grep -E "Running|Behind|Error"
```

## Fonctionnement détaillé

### Boucle de réconciliation

Toutes les `RECONCILE_INTERVAL_SECONDS` (10 s), l'opérateur liste les `MySQLCluster`, `MySQLBackup` et `MySQLRestore` du namespace et les réconcilie séquentiellement. Pas de watch : c'est plus simple et robuste (un état raté est rattrapé au cycle suivant). Chaque réconciliation est idempotente. Un échec sur un objet est loggé et n'empêche pas les autres.

### Réconciliation d'un MySQLCluster

1. Lit le Secret ; sinon statut `Pending`.
2. Applique (server-side apply) les 3 Services, le StatefulSet et le PVC de backups.
3. Pose le label `mysql.ahceneaiti.dev/role` sur chaque pod : ordinal 0 = `primary`, les autres = `replica`. Les Services s'appuient sur ce label, donc un pod recréé retrouve son rôle au cycle suivant.
4. Si le primaire est prêt : crée l'utilisateur `repl` (`REPLICATION SLAVE`) s'il n'existe pas.
5. Pour chaque réplica prêt : configure la réplication, force `super_read_only`, lit `SHOW REPLICA STATUS`.
6. Applique ou supprime le CronJob selon `spec.backup.schedule`.
7. Met à jour `status` (uniquement si changé).

### Démarrage des pods MySQL

Le conteneur démarre via un script (`resources.js`, `START_SCRIPT`) :

- `--server-id = 100 + ordinal` : identifiant unique par instance ;
- `--gtid-mode=ON --enforce-gtid-consistency=ON --log-bin --log-replica-updates` : binlog et GTID sur toutes les instances ;
- sur les réplicas (ordinal > 0), `MYSQL_DATABASE`, `MYSQL_USER` et `MYSQL_PASSWORD` sont supprimés de l'environnement : seul le primaire initialise la base et l'utilisateur applicatif, les réplicas les reçoivent par réplication.

### Configuration de la réplication

Sur un réplica :

1. `SHOW REPLICA STATUS` : si aucune source n'est configurée ou si `Source_Host` diffère du primaire attendu :
   - `STOP REPLICA` ;
   - `RESET BINARY LOGS AND GTIDS` si aucune source n'a jamais été configurée et que des GTID locaux existent (repart d'un historique vide pour éviter les transactions divergentes) ;
   - `CHANGE REPLICATION SOURCE TO SOURCE_HOST=<mysql-0 DNS>, SOURCE_USER='repl', SOURCE_AUTO_POSITION=1, GET_SOURCE_PUBLIC_KEY=1` (nécessaire pour l'authentification `caching_sha2_password` sans TLS) ;
   - `START REPLICA`.
2. Si IO et SQL threads sont arrêtés sans configuration à changer : `START REPLICA`.
3. `SET GLOBAL super_read_only = ON` si nécessaire. Cette variable n'est pas persistée : elle est réappliquée après chaque redémarrage de pod.

Un réplica recréé (PVC conservé) reprend sa position via GTID ; un réplica avec un nouveau volume repart de zéro et rattrape tout l'historique du binlog du primaire.

### Sauvegarde

Un Job (`backup-<nom>`) exécute dans l'image MySQL :

```bash
mysqldump -h"$DUMP_HOST" -uroot -p"$MYSQL_ROOT_PASSWORD" \
  --single-transaction --routines --triggers --set-gtid-purged=OFF \
  --databases "$MYSQL_DATABASE" | gzip > /backups/<fichier>.tmp
mv /backups/<fichier>.tmp /backups/<fichier>
```

- `DUMP_HOST` = `<cluster>-read` si au moins un réplica est prêt et réplique (le primaire n'est pas chargé), sinon `<cluster>`.
- `--single-transaction` : dump cohérent sans verrou bloquant (InnoDB).
- `--set-gtid-purged=OFF` : le dump est rejouable sur le primaire sans conflit de GTID.
- Écriture dans un `.tmp` puis `mv` : jamais de fichier partiel visible.
- Job : `backoffLimit: 3`.

Backups planifiés : un CronJob (`concurrencyPolicy: Forbid`) produit `scheduled-AAAAMMJJ-HHMMSS.sql.gz` et supprime les plus anciens au-delà de `retention`. Les backups ponctuels (`MySQLBackup`) ne sont **pas** concernés par la rotation.

### Restauration

Un Job (`restore-<nom>`) exécute :

```bash
gunzip -c /backups/<fichier> | mysql -h<cluster> -uroot -p"$MYSQL_ROOT_PASSWORD"
```

Cible : le primaire (Service `<cluster>`). Le dump contient `DROP TABLE IF EXISTS` / `CREATE TABLE` : les tables de la base sont **remplacées**. Les réplicas reçoivent les changements par réplication. Le volume est monté en lecture seule, `backoffLimit: 1`.

Si `backupName` est utilisé, l'opérateur attend que le `MySQLBackup` soit `Completed` (phase `Pending` en attendant) et échoue si celui-ci est `Failed` ou introuvable.

### Cycle de vie

- Supprimer un `MySQLBackup` / `MySQLRestore` supprime son Job (ownerReference). **Le fichier de backup reste sur le volume.**
- Supprimer le `MySQLCluster` supprime StatefulSet, Services, CronJob. Les PVC `data-*` et `<cluster>-backups` restent.
- Réduire `spec.replicas` supprime les pods d'ordinal le plus élevé ; leurs PVC restent (`kubectl delete pvc data-mysql-2` pour libérer).

## RBAC

Role limité au namespace (`deploy/rbac.yaml`) :

| Ressource | Verbes |
|-----------|--------|
| `mysqlclusters`, `mysqlbackups`, `mysqlrestores` | get, list |
| `…/status` | get, patch, update |
| `services`, `persistentvolumeclaims` | get, list, create, patch |
| `pods` | get, list, patch (labels de rôle) |
| `secrets` | get |
| `statefulsets`, `jobs` | get, list, create, patch |
| `cronjobs` | get, list, create, patch, delete |

## Configuration de l'opérateur

| Variable                     | Défaut    | Description |
|------------------------------|-----------|-------------|
| `WATCH_NAMESPACE`            | `default` | namespace surveillé (injecté depuis le pod dans `operator.yaml`) |
| `RECONCILE_INTERVAL_SECONDS` | `10`      | période de réconciliation |
| `KUBE_API`                   | (vide)    | URL de l'API pour le dev local (ex. `kubectl proxy`) ; sinon ServiceAccount du pod |

L'opérateur expose `GET :8081/` (200 si la boucle tourne), utilisé comme liveness probe. Il tourne en **1 réplica** (`strategy: Recreate`), sans élection de leader.

## Développement local

L'opérateur doit joindre les pods MySQL par leur DNS interne : le plus simple est donc de le tester dans le cluster (`docker build` + `kind load` + `kubectl rollout restart deploy/mysql-operator -n users-app`).

Pour tester uniquement la partie Kubernetes API hors cluster :

```bash
kubectl proxy &
cd operator && npm install
KUBE_API=http://127.0.0.1:8001 WATCH_NAMESPACE=users-app node src/index.js
```

(la configuration de la réplication échouera, les pods n'étant pas résolvables depuis l'hôte.)

Structure du code :

```
operator/
├── src/index.js      # boucle + health
├── src/kube.js       # client REST de l'API Kubernetes (apply, get, list, merge, remove)
├── src/resources.js  # construction des objets (StatefulSet, Services, Jobs, CronJob, PVC)
├── src/cluster.js    # réconciliation MySQLCluster
├── src/mysql.js      # SQL de réplication
├── src/jobs.js       # réconciliation MySQLBackup / MySQLRestore
└── deploy/           # crds.yaml, rbac.yaml, operator.yaml
```

## Limites connues

- **Pas de failover automatique** : le primaire est toujours l'ordinal 0. Si `mysql-0` est perdu, les réplicas restent en lecture seule ; la promotion d'un réplica est manuelle.
- Réplication **asynchrone** : un petit retard (`lagSeconds`) est possible, des écritures récentes peuvent être perdues en cas de perte du primaire.
- Backups : **seule la base `MYSQL_DATABASE`** est sauvegardée (pas les comptes MySQL ni les autres bases). Pas de point-in-time recovery.
- Le restore **écrase** les tables sans arrêter l'API ; prévoir une fenêtre de maintenance (`kubectl scale deploy/back-node --replicas=0`).
- Volume de backups en `ReadWriteOnce` : suffisant pour kind (1 nœud). Sur un cluster multi-nœuds, utiliser un stockage `ReadWriteMany` ou un stockage objet (non géré).
- Le mot de passe `repl` n'est pas rotatif (l'utilisateur n'est créé qu'une fois). Les secrets de démo sont en clair dans le repo.
- Pas de TLS entre instances ; pas de changement de version majeure de MySQL géré.
- Réconciliation par polling : jusqu'à 10 s de latence.

## Dépannage

| Symptôme | Piste |
|----------|-------|
| Cluster `Pending` | `kubectl get mc -o yaml` → `status.message` : secret absent ou sans `MYSQL_REPLICATION_PASSWORD` |
| Cluster `Provisioning` longtemps | `kubectl -n users-app describe pod mysql-0` ; l'init de MySQL prend ~30-60 s |
| Cluster `Degraded` | `status.instances[].error` ; `SHOW REPLICA STATUS\G` sur le réplica |
| Erreur de réplication (transaction en conflit) | supprimer le réplica et son PVC : `kubectl delete pod/mysql-1 pvc/data-mysql-1`, il se reconstruit |
| Backup `Failed` | `kubectl -n users-app logs job/backup-<nom>` |
| Restore `Failed` : fichier introuvable | vérifier `status.file` et le contenu du volume `<cluster>-backups` |
| Logs opérateur | `kubectl -n users-app logs deploy/mysql-operator` |
| `HTTP 429 storage is (re)initializing` au démarrage | normal juste après la création des CRD, résolu au cycle suivant |
