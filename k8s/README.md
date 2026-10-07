# Déploiement Kubernetes (kind)

Déploie l'API `back-node` et MySQL dans le namespace `users-app` d'un cluster [kind](https://kind.sigs.k8s.io/) local.

## Fichiers

| Fichier             | Rôle                                                              |
|---------------------|-------------------------------------------------------------------|
| `kind-config.yaml`  | Cluster kind : mappe `localhost:8080` vers le NodePort `30080`    |
| `namespace.yaml`    | Namespace `users-app`                                             |
| `secret.yaml`       | Identifiants MySQL (valeurs de démo)                              |
| `mysql.yaml`        | StatefulSet MySQL 8.4, PVC 1 Gi, Service `mysql:3306` (ClusterIP) |
| `back-node.yaml`    | Deployment `ahceneaiti/back-node:1.0` (2 replicas) + Service NodePort `30080` |
| `seed-job.yaml`     | Job qui génère 20 utilisateurs de test                            |

## 1. Déployer

Depuis la racine du repo :

```bash
kind create cluster --name users --config k8s/kind-config.yaml

kubectl apply -f k8s/namespace.yaml \
              -f k8s/secret.yaml \
              -f k8s/mysql.yaml \
              -f k8s/back-node.yaml

kubectl -n users-app get pods -w     # attendre mysql-0 et back-node en Running 1/1
```

L'`initContainer` `wait-for-mysql` retarde le démarrage de l'API tant que MySQL n'est pas joignable.

> `kind-config.yaml` doit être passé **à la création** du cluster. Sur un cluster existant sans ce mapping, utiliser un `port-forward` (voir plus bas).

## 2. Exposer l'API

L'API est un Service `NodePort` (`30080`), que `kind-config.yaml` publie sur `localhost:8080` :

```bash
curl http://localhost:8080/health
curl http://localhost:8080/users
```

Alternative sans mapping kind :

```bash
kubectl -n users-app port-forward svc/back-node 8080:3000
```

Pour un accès par nom de domaine, il faut un Ingress controller (non inclus).

## 3. Accéder à la base de données

MySQL n'est volontairement **pas exposé** hors du cluster (Service `ClusterIP`). Deux façons d'y accéder :

**Client MySQL dans le pod :**

```bash
kubectl -n users-app exec -it mysql-0 -- mysql -uappuser -papppassword users_db
# ex. : SELECT * FROM users;
```

**Depuis la machine hôte via port-forward :**

```bash
kubectl -n users-app port-forward svc/mysql 3307:3306
# dans un autre terminal, avec n'importe quel client :
mysql -h127.0.0.1 -P3307 -uappuser -papppassword users_db
```

Identifiants (voir `secret.yaml`) : base `users_db`, utilisateur `appuser` / `apppassword`, root `rootpassword`.

## 4. Générer des données

### Job de seed (20 utilisateurs)

```bash
kubectl apply -f k8s/seed-job.yaml
kubectl -n users-app wait --for=condition=complete job/seed-users --timeout=120s
kubectl -n users-app logs job/seed-users      # "seed terminé"
curl http://localhost:8080/users
```

Le Job insère `Utilisateur 1..20` (`user1@example.com`...) avec `INSERT IGNORE` : il peut être relancé sans doublon. Il est supprimé automatiquement 5 min après sa fin ; pour le relancer :

```bash
kubectl -n users-app delete job seed-users --ignore-not-found
kubectl apply -f k8s/seed-job.yaml
```

### Via l'API

```bash
for i in $(seq 1 5); do
  curl -s -X POST http://localhost:8080/users \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"Test $i\",\"email\":\"test$i@example.com\"}"
done
```

## 5. Vérifier / dépanner

```bash
kubectl -n users-app get all,pvc
kubectl -n users-app logs deploy/back-node
kubectl -n users-app logs mysql-0
kubectl -n users-app describe pod <pod>
```

## 6. Mettre à jour l'image

```bash
kubectl -n users-app set image deploy/back-node back-node=ahceneaiti/back-node:1.1
kubectl -n users-app rollout status deploy/back-node
```

Pour tester une image locale non poussée : `kind load docker-image ahceneaiti/back-node:1.0 --name users`.

## 7. Nettoyer

```bash
kubectl delete namespace users-app     # supprime aussi les données (PVC)
kind delete cluster --name users
```

## Sécurité

`secret.yaml` contient des mots de passe de démonstration, publics dans ce repo. À remplacer et ne plus versionner pour tout usage autre que local.
