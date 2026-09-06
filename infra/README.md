# SIMULYN — Infrastructure

Everything needed to run SIMULYN on Azure Kubernetes Service.

```
infra/
  terraform/    Azure resources: resource group, ACR, AKS cluster
  k8s/          Workloads: postgres, redis, api, executor, web, ingress
```

The GitHub Actions workflow at `.github/workflows/deploy.yml` builds the three
images and applies `infra/k8s/` on every push to `main`.

---

## What runs where

| Component | Kind | Replicas | Notes |
|---|---|---|---|
| `postgres` | StatefulSet | 1 | 32 Gi PVC. Single instance — see *Recovery*. |
| `redis` | StatefulSet | 1 | 8 Gi PVC, appendonly. Job queue **and** Socket.IO relay. |
| `api` | Deployment | 1 | Mounted at `/api`. Does not run student code in normal operation. |
| `executor` | Deployment | 2–6 (HPA) | Where student code actually runs. |
| `web` | Deployment | 1 | Next.js. |

Student code is enqueued to Redis and picked up by an executor pod, which holds
no database credentials and has no outbound network (`network-policy.yaml`).
That separation is the point of the layout — keep it when changing things.

The one exception: if Redis is unreachable the API falls back to grading
in-process, and its image still carries the toolchains for that. See
*Open question: toolchains in the API image* below.

---

## First-time setup

Runs once, by hand. Everything after this is CI.

### 1. Provision Azure

```bash
az login
cd infra/terraform
terraform init
terraform apply
```

Note the outputs — `acr_name` and `public_hostname` are both needed below. The
ACR name carries a random suffix because registry names are globally unique; a
fixed name collides with someone else's.

### 2. Point kubectl at the cluster

```bash
az aks get-credentials --resource-group rg-simulyn --name aks-simulyn
kubectl get nodes
```

### 3. Ingress controller

The `azure-dns-label-name` annotation turns the load balancer's IP into
`simulyn.southindia.cloudapp.azure.com`. It must match `dns_label` in Terraform.

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.annotations."service\.beta\.kubernetes\.io/azure-dns-label-name"=simulyn \
  --set controller.service.externalTrafficPolicy=Local
```

Wait for the public IP, then confirm DNS resolves before going near
cert-manager — an unresolvable hostname is the usual reason issuance fails:

```bash
kubectl -n ingress-nginx get svc ingress-nginx-controller -w
nslookup simulyn.southindia.cloudapp.azure.com
```

### 4. cert-manager

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl -n cert-manager rollout status deployment/cert-manager-webhook --timeout=180s
```

Set a real address in `infra/k8s/cert-manager-issuer.yaml` first — ACME
registration rejects obviously fake ones. Then:

```bash
kubectl apply -f infra/k8s/cert-manager-issuer.yaml
```

> Point `ingress.yaml` at `letsencrypt-staging` for the first attempt.
> Production Let's Encrypt permits 5 failed authorisations per hostname per
> hour, and a misconfigured ingress burns that quota in minutes. The staging
> certificate shows as untrusted in the browser — that is the expected result,
> and it means the plumbing works. Then switch the annotation to
> `letsencrypt-prod`, delete the secret
> (`kubectl -n simulyn delete secret simulyn-tls`), and let it reissue.

### 5. Secrets

Created by hand, once. Not in git; CI does not manage them.

```bash
kubectl create namespace simulyn --dry-run=client -o yaml | kubectl apply -f -

PG_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"

kubectl -n simulyn create secret generic simulyn-secrets \
  --from-literal=POSTGRES_USER=simulyn \
  --from-literal=POSTGRES_PASSWORD="$PG_PASSWORD" \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=JWT_REFRESH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=CLOUD_LLM_API_KEY='sk-ant-REPLACE' \
  --from-literal=DATABASE_URL="postgresql://simulyn:${PG_PASSWORD}@postgres:5432/simulyn?schema=public"
```

The password appears twice — as `POSTGRES_PASSWORD` and inside `DATABASE_URL`.
They must match, which is why it is generated into a variable rather than typed
twice. The `tr -d` strips characters that would need percent-encoding inside
the URL.

`infra/k8s/secrets.example.yaml` documents the shape. Do not apply it — it
would overwrite the real values with empty strings.

### 6. GitHub Actions secrets

| Secret | How to get it |
|---|---|
| `AZURE_CREDENTIALS` | `az ad sp create-for-rbac --name simulyn-ci --role Contributor --scopes /subscriptions/SUB_ID/resourceGroups/rg-simulyn --sdk-auth` |
| `ACR_NAME` | `terraform output -raw acr_name` |

The service principal also needs push rights on the registry:

```bash
SP_ID=$(az ad sp list --display-name simulyn-ci --query "[0].appId" -o tsv)
ACR_ID=$(az acr show --name "$ACR_NAME" --query id -o tsv)
az role assignment create --assignee "$SP_ID" --role AcrPush --scope "$ACR_ID"
```

### 7. First deploy

Push to `main` and let the workflow run, or apply by hand after substituting
the `REPLACE_WITH_ACR` placeholder in `api.yaml`, `web.yaml` and
`executor.yaml`:

```bash
kubectl apply -f infra/k8s/namespace.yaml
kubectl apply -f infra/k8s/configmap.yaml
kubectl apply -f infra/k8s/network-policy.yaml
kubectl apply -f infra/k8s/postgres.yaml
kubectl apply -f infra/k8s/redis.yaml
kubectl apply -f infra/k8s/api.yaml
kubectl apply -f infra/k8s/executor.yaml
kubectl apply -f infra/k8s/web.yaml
kubectl apply -f infra/k8s/ingress.yaml
kubectl apply -f infra/k8s/pg-backup-cronjob.yaml
```

Never `kubectl apply -f infra/k8s/` as a directory: the glob picks up
`secrets.example.yaml` and wipes the live secret.

### 8. Seed the database

Migrations run automatically in the API's initContainer. Seeding is separate —
`seed.ts` truncates before inserting, so it is never automatic.

```bash
kubectl -n simulyn exec deployment/api -- \
  pnpm --filter @simulyn/shared exec tsx prisma/seed.ts
```

---

## Verification

```bash
kubectl -n simulyn get pods
kubectl -n simulyn get certificate          # READY should be True

curl -fsS https://simulyn.southindia.cloudapp.azure.com/healthz
curl -o /dev/null -w '%{http_code}\n' https://simulyn.southindia.cloudapp.azure.com/api/docs

kubectl -n simulyn logs deployment/executor --tail=20
```

**Executor isolation.** Worth actually running: a NetworkPolicy applies
silently on a cluster with no policy engine and protects nothing.

```bash
POD=$(kubectl -n simulyn get pod -l app=executor -o name | head -1)

# Should fail — no route off the cluster.
kubectl -n simulyn exec "$POD" -- timeout 5 wget -qO- https://example.com \
  && echo "FAIL: executor reached the internet" || echo "OK: egress blocked"

# Should fail — this endpoint hands out managed identity tokens.
kubectl -n simulyn exec "$POD" -- timeout 5 wget -qO- \
  "http://169.254.169.254/metadata/instance?api-version=2021-02-01" \
  && echo "FAIL: metadata reachable" || echo "OK: metadata blocked"

# Should succeed — Redis is the one thing it may reach.
kubectl -n simulyn exec "$POD" -- timeout 5 nc -z redis 6379 \
  && echo "OK: redis reachable"
```

**Test suites** against the cluster:

```bash
kubectl -n simulyn port-forward svc/api 3001:3001
pnpm --filter api test:smoke
```

> Two caveats. The suites in `apps/api/test/` address the API at the root
> (`/auth/login`); on a cluster where `API_GLOBAL_PREFIX=api` they need the
> prefix. And they **reseed** — never point them at an instance holding real
> student work.

---

## Backups

`pg-backup-cronjob.yaml` dumps to a 16 Gi PVC nightly at 02:00 IST and keeps 7
days. Restore:

```bash
kubectl -n simulyn exec -it statefulset/postgres -- sh -c \
  "gunzip -c /backups/simulyn-YYYYMMDD-HHMMSS.sql.gz | psql -U simulyn -d simulyn"
```

Confirm they are actually running — a CronJob that has failed for a month looks
identical to one that has never run:

```bash
kubectl -n simulyn get cronjob postgres-backup
kubectl -n simulyn get jobs -l app=postgres-backup
```

The dump lives on a disk in the same region as the database it backs up. That
covers "someone dropped a table", not "the region is gone". For off-site
copies, add a step that pushes to Blob Storage with a lifecycle rule.

---

## Recovery

**PostgreSQL is a single pod with a single disk.** If the node dies the pod
reschedules and reattaches. If the *disk* is lost, the nightly dump is the only
copy. That is the trade the plan made for cost — roughly $3/month against ~$25
for Azure Database for PostgreSQL. Defensible for a university lab, wrong for
anything that must not lose a day's work; switching is a `DATABASE_URL` change
and deleting `postgres.yaml`.

**Redis holds queued jobs.** Appendonly means a restart keeps in-flight work.
Losing it entirely costs the submissions currently queued — the API falls back
to grading in-process when the queue is unreachable, so the site stays up.

---

## Images

Three images, all built from the repo root (the Dockerfiles reference
`packages/shared`, so the build context has to be the workspace root, not the
app directory).

| Image | Contains | Notes |
|---|---|---|
| `simulyn-api` | Node + toolchains | Toolchains are for the fallback path only — see below. |
| `simulyn-executor` | Node + python3, g++, openjdk17 | The only image that is *supposed* to run student code. |
| `simulyn-web` | Node + Next.js standalone output | `NEXT_PUBLIC_API_URL` is baked in at build time. |

Both server images copy the whole workspace, devDependencies included, because
pnpm's symlinked `node_modules` does not survive being pruned. The API genuinely
needs the Prisma CLI at runtime for the migration initContainer.

Ownership is set with `COPY --chown` rather than a following `chown -R`.
Re-owning after the copy rewrites every file into a second layer — that alone
was adding roughly 500 MB per image.

### Open question: toolchains in the API image

The API no longer executes student code — it enqueues to Redis. But
`ExecutionQueueService` falls back to running jobs in-process when the queue is
unreachable, and that fallback needs python/g++/javac present. So the API image
still ships ~600 MB of compilers it normally never invokes.

The trade is real in both directions:

- **Keep them** (current): a Redis outage degrades to slower grading instead of
  an outage. But the API pod *can* execute untrusted code, which is the thing
  the executor split was meant to prevent.
- **Drop them**: the API image loses ~600 MB and can no longer run student code
  under any circumstance. A Redis outage then fails submissions outright.

For a single-box `docker-compose` install the fallback is worth having. On
Kubernetes, where Redis is a managed dependency of the deployment anyway, the
stronger isolation is probably the better default. Decide deliberately — do not
let it drift.

---

## Cost

| Resource | SKU | Monthly |
|---|---|---|
| AKS control plane | Free tier | $0 |
| Node | Standard_B2s | ~$30 |
| ACR | Basic | ~$5 |
| PVC — postgres | 32 Gi Standard SSD | ~$3 |
| PVC — redis | 8 Gi Standard SSD | ~$1 |
| PVC — backups | 16 Gi Standard SSD | ~$2 |
| Public IP + LB | Standard | ~$5 |
| Cloud LLM | pay-per-use | ~$5–10 |
| **Total** | | **~$51–56** |

Above the plan's $44–49: the backup PVC was never costed there, and a second
node during exam peaks adds ~$0.04/hour while it lasts.

### Capacity

A B2s node is 2 vCPU / 4 GiB, of which AKS reserves roughly 0.6 vCPU / 1.2 GiB.
Requests as configured:

| Pod | CPU | Memory |
|---|---|---|
| postgres | 100m | 256 Mi |
| redis | 50m | 64 Mi |
| api | 200m | 512 Mi |
| web | 100m | 256 Mi |
| executor × 2 | 300m | 768 Mi |
| **Total** | **750m** | **~1.8 Gi** |

That fits one node. Each extra executor is +150m / +384 Mi, so the HPA ceiling
of 6 needs a second node — which is why the cluster autoscaler is on and
`node_max_count` is 3. Raising `maxReplicas` past 6 without raising
`node_max_count` gets you pods stuck `Pending`.
