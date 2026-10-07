# Référence API

Base URL (kind) : `http://localhost:8080`. Corps et réponses en JSON.

## Modèle User

| Champ        | Type      | Notes                  |
|--------------|-----------|------------------------|
| `id`         | int       | auto-incrémenté        |
| `name`       | string    | requis, max 100        |
| `email`      | string    | requis, unique, max 255|
| `created_at` | timestamp |                        |
| `updated_at` | timestamp |                        |

## Endpoints

| Méthode | Route         | Description                    | Succès |
|---------|---------------|--------------------------------|--------|
| GET     | `/health`     | état API + connexion MySQL     | 200    |
| GET     | `/users`      | liste des utilisateurs         | 200    |
| GET     | `/users/:id`  | un utilisateur                 | 200    |
| POST    | `/users`      | création (`name`, `email`)     | 201    |
| PUT     | `/users/:id`  | modification (`name`/`email`)  | 200    |
| DELETE  | `/users/:id`  | suppression                    | 204    |

## Erreurs

| Code | Cas                                   | Exemple                                |
|------|---------------------------------------|----------------------------------------|
| 400  | validation                            | `{"error":"email invalide"}`           |
| 404  | utilisateur inexistant                | `{"error":"utilisateur introuvable"}`  |
| 409  | email déjà utilisé                    | `{"error":"email déjà utilisé"}`       |
| 500  | erreur interne                        | `{"error":"erreur interne"}`           |
| 503  | `/health` : MySQL injoignable         | `{"status":"db indisponible"}`         |

## Exemples

```bash
# créer
curl -X POST localhost:8080/users -H 'Content-Type: application/json' \
  -d '{"name":"Alice","email":"alice@example.com"}'
# lire
curl localhost:8080/users/1
# modifier
curl -X PUT localhost:8080/users/1 -H 'Content-Type: application/json' \
  -d '{"name":"Alice B"}'
# supprimer
curl -X DELETE localhost:8080/users/1
```
