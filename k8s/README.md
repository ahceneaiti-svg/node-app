# Déploiement Kubernetes (kind)

Déploie dans le namespace `users-app` d'un cluster [kind](https://kind.sigs.k8s.io/) local :

- l'opérateur `mysql-operator` (voir [`../operator/README.md`](../operator/README.md)) ;
- un cluster MySQL **primaire + réplica** géré par l'opérateur (réplication, backup, restore) ;
- l'API `back-node`.

## Fichiers

| Fichier                  | Rôle |
|--------------------------|------|
| `kind-config.yaml`       | Cluster kind : mappe `localhost:8080` vers le NodePort `30080` |
| `namespace.yaml`         | Namespace `users-app` |
| `secret.yaml`            | Identifiants MySQL, dont `MYSQL_REPLICATION_PASSWORD` (valeurs de démo) |
| `mysql-cluster.yaml`     | `MySQLCluster` : 1 primaire + 1 réplica, backup planifié quotidien |
| `back-node.yaml`         | Deployment `ahceneaiti/back-node:1.0` (2 replicas) + Service NodePort `30080` |
| `seed-job.yaml`          | Job qui génère 20 utilisateurs de test |
| `examples/backup.yaml`   | Exemple `MySQLBackup` |
| `examples/restore.yaml`  | Exemple `MySQLRestore` |
| `../operator/deploy/`    | CRD, RBAC et Deployment de l'opérateur |

## 1. Déployer

Depuis la racine du repo :

```bash
# cluster
kind create cluster --name users --config k8s/kind-config.yaml

# image de l'opérateur (construite en local, chargée dans kind)
docker build -t ahceneaiti/mysql-operator:1.0 operator
kind load docker-image ahceneaiti/mysql-operator:1.0 --name users

# CRD + namespace, puis opérateur
kubectl apply -f operator/deploy/crds.yaml -f k8s/namespace.yaml
kubectl apply -f operator/deploy/rbac.yaml -f operator/deploy/operator.yaml

# secret + cluster MySQL
kubectl apply -f k8s/secret.yaml -f k8s/mysql-cluster.yaml
kubectl -n users-app wait --for=jsonpath='{.status.phase}'=Ready mysqlcluster/mysql --timeout=300s

# API
kubectl apply -f k8s/back-node.yaml
kubectl -n users-app rollout status deploy/back-node
```

> `kind-config.yaml` doit être passé **à la création** du cluster. Sur un cluster existant sans ce mapping, utiliser un `port-forward` (voir plus bas).
>
> Les CRD doivent être installées avant `mysql-cluster.yaml`. L'`initContainer` `wait-for-mysql` de l'API attend le Service `mysql` (primaire).

Résultat attendu :

```bash
kubectl -n users-app get mysqlcluster,pods
# NAME      PHASE   PRIMARY   REPLICAS   READY-REPLICAS
# mysql     Ready   mysql-0   1          1
# pod/mysql-0, pod/mysql-1, pod/mysql-operator-*, pod/back-node-* (x2)
```

## 2. Exposer l'API

Service `NodePort` (`30080`), publié par `kind-config.yaml` sur `localhost:8080` :

```bash
curl http://localhost:8080/health
curl http://localhost:8080/users
```

Alternative sans mapping kind :

```bash
kubectl -n users-app port-forward svc/back-node 8080:3000
```

Pour un accès par nom de domaine, il faut un Ingress controller (non inclus).

## 3. Base de données : primaire et réplica

| Service        | Cible                    | Usage |
|----------------|--------------------------|-------|
| `mysql`        | `mysql-0` (primaire)     | écritures (utilisé par l'API via `DB_HOST=mysql`) |
| `mysql-read`   | `mysql-1..N` (réplicas)  | lectures, dumps, requêtes de reporting |
| `mysql-headless` | tous les pods          | DNS par pod (`mysql-0.mysql-headless`) |

MySQL n'est volontairement **pas exposé** hors du cluster (Services `ClusterIP`).

**Client MySQL dans un pod :**

```bash
kubectl -n users-app exec -it mysql-0 -- mysql -uappuser -papppassword users_db   # primaire
kubectl -n users-app exec -it mysql-1 -- mysql -uappuser -papppassword users_db   # réplica (lecture seule)
```

**Depuis la machine hôte via port-forward :**

```bash
kubectl -n users-app port-forward svc/mysql 3307:3306          # primaire
kubectl -n users-app port-forward svc/mysql-read 3308:3306     # réplicas
mysql -h127.0.0.1 -P3307 -uappuser -papppassword users_db
```

Identifiants (voir `secret.yaml`) : base `users_db`, utilisateur `appuser` / `apppassword`, root `rootpassword`.

### Vérifier la réplication

```bash
kubectl -n users-app get mysqlcluster mysql -o jsonpath='{.status.instances}'   # replicating, lagSeconds
kubectl -n users-app exec mysql-1 -- mysql -uroot -prootpassword -e "SHOW REPLICA STATUS\G" | grep -E "Running|Behind|Error"

# une écriture sur le réplica est refusée (super_read_only)
kubectl -n users-app exec mysql-1 -- mysql -uappuser -papppassword users_db \
  -e "INSERT INTO users(name,email) VALUES('x','x@x.fr')"
# ERROR 1290 ... --read-only option
```

### Ajouter / retirer des réplicas

```bash
kubectl -n users-app patch mysqlcluster mysql --type merge -p '{"spec":{"replicas":2}}'
```

Le nouveau réplica est configuré et rattrape les données automatiquement. En réduisant, les PVC `data-mysql-N` restent : `kubectl -n users-app delete pvc data-mysql-2` pour les supprimer.

## 4. Générer des données

### Job de seed (20 utilisateurs)

```bash
kubectl apply -f k8s/seed-job.yaml
kubectl -n users-app wait --for=condition=complete job/seed-users --timeout=120s
kubectl -n users-app logs job/seed-users      # "seed terminé"
curl http://localhost:8080/users
```

Le Job insère `Utilisateur 1..20` (`user1@example.com`...) avec `INSERT IGNORE` : relançable sans doublon. Il est supprimé automatiquement 5 min après sa fin ; pour le relancer :

```bash
kubectl -n users-app delete job seed-users --ignore-not-found
kubectl apply -f k8s/seed-job.yaml
```

Les données sont écrites sur le primaire et répliquées vers `mysql-1`.

### Via l'API

```bash
for i in $(seq 1 5); do
  curl -s -X POST http://localhost:8080/users \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"Test $i\",\"email\":\"test$i@example.com\"}"
done
```

## 5. Sauvegarde et restauration

Détails dans [`../operator/README.md`](../operator/README.md).

### Sauvegarde planifiée

`mysql-cluster.yaml` définit `backup.schedule: "0 2 * * *"` et `retention: 7` : un CronJob `mysql-backup` produit chaque nuit `scheduled-AAAAMMJJ-HHMMSS.sql.gz` sur le volume `mysql-backups`. Pour le lancer tout de suite :

```bash
kubectl -n users-app create job --from=cronjob/mysql-backup backup-now
kubectl -n users-app logs job/backup-now
```

### Sauvegarde ponctuelle

```bash
kubectl apply -f k8s/examples/backup.yaml
kubectl -n users-app wait --for=jsonpath='{.status.phase}'=Completed mysqlbackup/backup-manuel-1 --timeout=120s
kubectl -n users-app get mysqlbackup        # PHASE, FILE
```

Le dump est pris depuis le réplica (`mysql-read`) pour ne pas charger le primaire.

### Lister les fichiers de backup

```bash
kubectl -n users-app run ls-backups --restart=Never --image=mysql:8.4 \
  --overrides='{"spec":{"containers":[{"name":"ls","image":"mysql:8.4","command":["ls","-lh","/backups"],"volumeMounts":[{"name":"b","mountPath":"/backups"}]}],"volumes":[{"name":"b","persistentVolumeClaim":{"claimName":"mysql-backups"}}]}}'
kubectl -n users-app wait --for=jsonpath='{.status.phase}'=Succeeded pod/ls-backups --timeout=60s
kubectl -n users-app logs ls-backups && kubectl -n users-app delete pod ls-backups
```

### Restauration

```bash
kubectl apply -f k8s/examples/restore.yaml      # backupName: backup-manuel-1
kubectl -n users-app wait --for=jsonpath='{.status.phase}'=Completed mysqlrestore/restore-manuel-1 --timeout=120s
```

Pour restaurer un backup planifié, utiliser `file:` à la place de `backupName:` :

```yaml
spec:
  clusterName: mysql
  file: scheduled-20261007-020000.sql.gz
```

La restauration **remplace** les tables de `users_db` sur le primaire et se propage au réplica. Pour éviter les écritures pendant l'opération : `kubectl -n users-app scale deploy/back-node --replicas=0`, puis `--replicas=2` après.

### Scénario de test complet

```bash
Q() { kubectl -n users-app exec mysql-0 -- mysql -uroot -prootpassword -N -e "$1" 2>/dev/null; }
kubectl apply -f k8s/seed-job.yaml && kubectl -n users-app wait --for=condition=complete job/seed-users --timeout=120s
kubectl apply -f k8s/examples/backup.yaml
kubectl -n users-app wait --for=jsonpath='{.status.phase}'=Completed mysqlbackup/backup-manuel-1 --timeout=120s
Q "DELETE FROM users_db.users"; Q "SELECT COUNT(*) FROM users_db.users"     # 0
kubectl apply -f k8s/examples/restore.yaml
kubectl -n users-app wait --for=jsonpath='{.status.phase}'=Completed mysqlrestore/restore-manuel-1 --timeout=120s
Q "SELECT COUNT(*) FROM users_db.users"                                      # 20
```

## 6. Vérifier / dépanner

```bash
kubectl -n users-app get all,pvc,mysqlcluster,mysqlbackup,mysqlrestore
kubectl -n users-app logs deploy/mysql-operator
kubectl -n users-app logs deploy/back-node
kubectl -n users-app logs mysql-0
kubectl -n users-app describe pod <pod>
```

## 7. Mettre à jour les images

```bash
# API
kubectl -n users-app set image deploy/back-node back-node=ahceneaiti/back-node:1.1
# Opérateur (image locale)
docker build -t ahceneaiti/mysql-operator:1.0 operator
kind load docker-image ahceneaiti/mysql-operator:1.0 --name users
kubectl -n users-app rollout restart deploy/mysql-operator
```

## 8. Nettoyer

```bash
kubectl delete namespace users-app     # supprime pods, données MySQL et backups (PVC)
kubectl delete -f operator/deploy/crds.yaml
kind delete cluster --name users
```

## Sécurité

`secret.yaml` contient des mots de passe de démonstration, publics dans ce repo. À remplacer et ne plus versionner pour tout usage autre que local.
