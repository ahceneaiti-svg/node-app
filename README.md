# back-node — API de gestion des utilisateurs

API REST Node.js (Express) stockant des utilisateurs dans MySQL. Image Docker : `ahceneaiti/back-node:1.0`. Déploiement sur cluster local [kind](https://kind.sigs.k8s.io/).

## Structure

```
.
├── back-node/          # code de l'API + Dockerfile
│   ├── src/index.js    # routes Express
│   ├── src/db.js       # pool MySQL + création de la table
│   ├── Dockerfile
│   └── package.json
├── k8s/                # manifestes Kubernetes
│   ├── kind-config.yaml  # cluster kind (port 8080 -> NodePort 30080)
│   ├── namespace.yaml
│   ├── secret.yaml       # identifiants MySQL (démo)
│   ├── mysql-cluster.yaml # MySQLCluster (primaire + réplica, backups)
│   ├── seed-job.yaml     # génération de données
│   ├── examples/         # MySQLBackup / MySQLRestore
│   ├── README.md         # guide de déploiement détaillé
│   └── back-node.yaml    # Deployment (2 replicas) + Service NodePort
├── operator/           # opérateur Kubernetes MySQL (réplication, backup, restore)
│   └── README.md       # documentation de l'opérateur
└── docs/API.md         # référence de l'API
```

## Prérequis

Node.js >= 20, Docker, kind, kubectl.

## Lancer en local (sans Kubernetes)

```bash
docker run -d --name mysql -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=users_db mysql:8.4

cd back-node && npm install
DB_HOST=127.0.0.1 DB_USER=root DB_PASSWORD=root npm start
```

## Variables d'environnement

| Variable      | Défaut      | Description          |
|---------------|-------------|----------------------|
| `PORT`        | `3000`      | Port HTTP            |
| `DB_HOST`     | `localhost` | Hôte MySQL           |
| `DB_PORT`     | `3306`      | Port MySQL           |
| `DB_USER`     | `root`      | Utilisateur MySQL    |
| `DB_PASSWORD` | (vide)      | Mot de passe MySQL   |
| `DB_NAME`     | `users_db`  | Base de données      |

La table `users` est créée automatiquement au démarrage. L'API réessaie la connexion MySQL (30 x 2 s).

## Image Docker

```bash
cd back-node
docker build -t ahceneaiti/back-node:1.0 .
docker login
docker push ahceneaiti/back-node:1.0
```

## Déploiement sur kind

```bash
# 1. cluster (expose localhost:8080)
kind create cluster --name users --config k8s/kind-config.yaml

# 2. opérateur MySQL (image locale chargée dans kind)
docker build -t ahceneaiti/mysql-operator:1.0 operator
kind load docker-image ahceneaiti/mysql-operator:1.0 --name users
kubectl apply -f operator/deploy/crds.yaml -f k8s/namespace.yaml
kubectl apply -f operator/deploy/rbac.yaml -f operator/deploy/operator.yaml

# 3. cluster MySQL (primaire + réplica) puis API
kubectl apply -f k8s/secret.yaml -f k8s/mysql-cluster.yaml
kubectl -n users-app wait --for=jsonpath='{.status.phase}'=Ready mysqlcluster/mysql --timeout=300s
kubectl apply -f k8s/back-node.yaml

# 4. attendre que tout soit prêt
kubectl -n users-app get pods -w

# 5. test
curl http://localhost:8080/health
curl -X POST http://localhost:8080/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice","email":"alice@example.com"}'
curl http://localhost:8080/users
```

Le cluster tire l'image depuis Docker Hub. Pour tester une image locale non poussée : `kind load docker-image ahceneaiti/back-node:1.0 --name users`.

### Architecture

- `mysql` : `MySQLCluster` géré par l'opérateur : primaire `mysql-0` + réplica `mysql-1` (réplication GTID), Services `mysql` (écritures) et `mysql-read` (lectures), backups et restore via CR. Voir `operator/README.md`.
- `back-node` : Deployment 2 replicas, `initContainer` qui attend MySQL, probes sur `/health`, Service NodePort `30080` mappé sur `localhost:8080`.
- Identifiants MySQL dans le Secret `mysql-secret`.

### Nettoyage

```bash
kubectl delete namespace users-app   # supprime aussi les données MySQL
kind delete cluster --name users
```

### Dépannage

```bash
kubectl -n users-app logs deploy/back-node
kubectl -n users-app logs mysql-0
kubectl -n users-app describe pod <pod>
```

## Sécurité

`k8s/secret.yaml` contient des mots de passe de démonstration. Pour autre chose qu'un test local : changer les valeurs, ne pas les versionner (SealedSecrets, External Secrets...).
