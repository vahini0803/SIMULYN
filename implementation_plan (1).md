# SIMULYN — Azure AKS Deployment & Executor Microservice Migration

Complete implementation plan for deploying SIMULYN to Azure Kubernetes Service (AKS) and migrating the code execution engine from an in-process semaphore to a dedicated executor microservice with a warm pod pool.

---

> [!NOTE]
> **Audited against the codebase on 2026-08-26.** The plan was written against
> an earlier shape of the repo; the following were corrected in place rather
> than left to fail during implementation:
>
> - `executor.ts` imports `Logger` from `@nestjs/common`, so the "these files
>   have zero NestJS dependencies" claim was false — de-Nest it before moving.
> - `trace.types.ts` was missing from the move list; `harness.ts` imports it.
> - `Executor.prepare()` is `(lang, program, options)` and *reports*
>   `compileError` rather than throwing — the processor's `try/catch` for
>   "Compilation failed" could never fire.
> - `splitDriverOutput()` returns `{ actual, studentOutput }`, and `ExecResult`
>   uses `executionMs` — not `driverOutput`/`studentStdout`/`executionTimeMs`.
> - Prisma columns are `TestCase.expected` and `Problem.harness`, not
>   `expectedOutput`/`harnessJson`.
> - `Executor` already owns a `Semaphore`; the processor's second one
>   double-limited concurrency.
> - Apps in this workspace are unscoped (`api`, `web`), so the executor package
>   is `executor`, not `@simulyn/executor`.
> - Hidden-test-case masking must stay in the API — it is a security boundary
>   (`apps/api/test/hidden-leak.mjs`).
> - **The frontend work for asynchronous submissions was missing entirely** and
>   is now a section of its own under Phase 2.

---

## Architecture Summary

```mermaid
graph TB
    subgraph Internet
        Students[Students / Teachers / Admins]
    end

    subgraph Azure["Azure — South India Region"]
        subgraph AKS["AKS Cluster (Free Tier Control Plane)"]
            subgraph Ingress["NGINX Ingress Controller"]
                ING[Ingress Resource<br/>simulyn.southindia.cloudapp.azure.com]
            end

            subgraph AppPods["Application Pods"]
                WEB[Web Pod<br/>Next.js 15]
                API[API Pod<br/>NestJS 11]
            end

            subgraph DataPods["Data Pods"]
                PG[PostgreSQL 16 Pod<br/>+ PersistentVolume]
                REDIS[Redis Pod<br/>+ PersistentVolume]
            end

            subgraph ExecutorPool["Executor Pool (HPA: 2-8 pods)"]
                EX1[Executor Pod 1<br/>Python/JS/C++/Java]
                EX2[Executor Pod 2<br/>Python/JS/C++/Java]
                EXN[Executor Pod N<br/>...]
            end
        end

        ACR[Azure Container Registry<br/>Basic Tier]
    end

    subgraph External["External Services"]
        LLM[Anthropic / OpenAI API<br/>AI Mentor]
    end

    Students -->|HTTPS| ING
    ING -->|/| WEB
    ING -->|/api/*| API
    API -->|Prisma| PG
    API -->|BullMQ enqueue| REDIS
    API -->|Socket.IO Redis Adapter| REDIS
    REDIS -->|BullMQ dequeue| EX1
    REDIS -->|BullMQ dequeue| EX2
    REDIS -->|BullMQ dequeue| EXN
    EX1 -->|Results via BullMQ| REDIS
    API -->|HTTPS| LLM
```

---

## Decisions Made

| Decision | Choice | Rationale |
|---|---|---|
| Cloud Platform | **Azure** | AKS for K8s, strong isolation for untrusted code |
| Azure Region | **South India** | Low latency for Indian university |
| Execution Model | **Warm pod pool** | Pre-warmed executor pods pulling from BullMQ queue |
| Message Queue | **Redis (self-hosted in K8s)** via BullMQ | Zero extra cost, NestJS-native |
| Executor Image | **Single generic image** with all 4 toolchains | Simpler ops, any pod runs any language |
| Database | **PostgreSQL in K8s pod** with PersistentVolume | Cheapest option (~\$5/month for disk) |
| AI Mentor | **Cloud LLM only** (Anthropic/OpenAI) | No GPU needed, pay-per-use |
| WebSockets | **Socket.IO + Redis adapter** | Minimal code change, zero additional cost |
| Ingress | **NGINX Ingress + cert-manager** (Let's Encrypt) | Free HTTPS, battle-tested |
| Domain | **Azure-provided subdomain** | `simulyn.southindia.cloudapp.azure.com` |
| Executor Worker | **New `apps/executor` NestJS microservice** | Clean separation in monorepo |
| Executor Scaling | **HPA: 2 base → 8 max** based on queue depth | Handles exam peaks |
| IaC | **Terraform** (Azure infra) + **plain K8s YAML** | Reproducible, simple |
| CI/CD | **GitHub Actions** | Build → Push to ACR → Deploy to AKS |
| Monthly Budget | **Under \$50** | Single B2s node, self-hosted Redis & PostgreSQL |

---

## Estimated Monthly Cost

| Resource | SKU | Cost |
|---|---|---|
| AKS Control Plane | Free tier | \$0 |
| AKS Node | Standard_B2s (2 vCPU, 4 GB) | ~\$30 |
| ACR | Basic | ~\$5 |
| PersistentVolume (PostgreSQL) | 32 GB Standard SSD | ~\$3 |
| PersistentVolume (Redis) | 8 GB Standard SSD | ~\$1 |
| Public IP + Load Balancer | Standard LB | ~\$5 |
| Cloud LLM (AI Mentor) | Pay-per-use | ~\$5-10 |
| **Total** | | **~\$44-49/month** |

> [!NOTE]
> During exam peaks, the cluster autoscaler may add a second B2s node temporarily (~\$0.04/hour), but this is only for the duration of the exam.

---

## Phase 1: Infrastructure & Current Architecture Deployment

> [!TIP]
> **Implemented on 2026-08-27.** Files live in `infra/terraform/`, `infra/k8s/`
> and `.github/workflows/deploy.yml`; `infra/README.md` is the runbook and
> supersedes the Phase 3 checklist below. All 25 manifests validate against the
> Kubernetes 1.30 schemas (kubeconform, `-strict`). **Terraform is unvalidated**
> — no `terraform` binary on this machine, so `init`/`validate`/`plan` have not
> been run.
>
> Corrected while implementing:
>
> - **`/api` routing was broken.** The ingress sends `/api/*` to the API, but
>   the API serves its routes at the root — every request would have 404'd.
>   Fixed with an opt-in `API_GLOBAL_PREFIX` env var (empty in dev so the URLs
>   and all 135 tests are unchanged, `api` in the ConfigMap). No ingress rewrite,
>   which also keeps Swagger working at its literal `/api/docs`.
> - **`NEXT_PUBLIC_API_URL` ending in `/api` would have broken WebSockets.**
>   socket.io-client reads a URL's path as the *namespace*, so it would have
>   asked for `/api/proctoring` — a namespace that does not exist. The client
>   now connects to the origin; `apps/web/src/lib/socket.ts`.
> - **Probes pointed at `/api/docs-json`**, tying liveness to Swagger being
>   enabled and serialising the whole spec every 30s. Added `/healthz`
>   (liveness) and `/readyz` (readiness, checks the database), both excluded
>   from the global prefix so one path works in every deployment shape.
> - **`infra/k8s/executor.yaml` did not exist** — the CI workflow applied and
>   waited on it regardless. Written, with a CPU-based HPA plus an optional
>   KEDA `ScaledObject` for scaling on real queue depth (plain HPA cannot read
>   a queue).
> - **`postgres-backup-pvc` did not exist** either, and the CronJob passed
>   `POSTGRES_PASSWORD` where `pg_dump` reads `PGPASSWORD` — it would have hung
>   waiting for a password. Both fixed; the script now also fails on a
>   truncated dump instead of reporting success.
> - **NetworkPolicy was in the verification steps but never written**, and
>   would have been silently ignored anyway: AKS needs a policy engine.
>   Terraform now sets `network_policy = "calico"`, and
>   `infra/k8s/network-policy.yaml` confines the executor to DNS and Redis —
>   including blocking `169.254.169.254`, which hands out managed-identity
>   tokens.
> - **`kubectl apply -f infra/k8s/` would have wiped the secret.** The glob
>   includes the secret template. Renamed to `secrets.example.yaml` and the
>   workflow applies files explicitly.
> - **ACR names are globally unique**, so a hard-coded `simulynacr` likely
>   fails on first apply. Terraform appends a random suffix and CI resolves the
>   name from a secret rather than assuming it.
> - **`maxReplicas: 8` does not fit.** At 384 Mi requested each, 8 executors
>   plus the rest of the stack exceeds three B2s nodes. Capped at 6, with the
>   arithmetic written out in `infra/README.md`.
> - Deployments for postgres and redis became **StatefulSets** (both own a PVC),
>   `fsGroup` set so the CSI disk is writable by the image's user, and rollout
>   timeouts raised — the plan's 120s does not cover an initContainer migration
>   plus a cold image pull.
> - Added a `letsencrypt-staging` issuer. Production Let's Encrypt allows 5
>   failed authorisations per hostname per hour, which one bad ingress exhausts.
>
> Found while validating the images:
>
> - **Java submissions scored 0 on every test case.** `detectJavaMainClass()`
>   took the last `class` declared before `main`, which in the generated driver
>   is the nested `static class J` helper inside `Main` — so `java -cp <dir> J`
>   died with ClassNotFoundException. Never seen locally because no JDK is
>   installed on the dev machine, so Java never got past "runtime not
>   installed". Now resolves the enclosing *top-level* class using brace depth
>   that ignores comments and string/char literals.
>   14 regression tests: `packages/shared/test/java-main-class.mjs`.
> - **`removeOnComplete: true` raced `waitUntilFinished`.** BullMQ deleted the
>   job the instant it completed, so the waiter could not read the result and
>   threw `Missing key for job <id>. isFinished`. Now
>   `removeOnComplete: { age: 60, count: 1000 }`.
> - **A single queue failure disabled the queue permanently.** `queueUsable`
>   latched to `false` for the life of the process, so one Redis blip silently
>   turned the API pod into a code-execution host until someone restarted it —
>   the exact thing the executor split exists to prevent. Replaced with a 60s
>   cooldown that retries, and the log line now names the consequence out loud.
>   Verified by stopping the worker (degrades, grades in-process, `mode:
>   inline`) and restarting it (returns to `mode: queue` on its own).
> - **`chown -R` after `COPY` nearly doubled both images**, re-owning every file
>   into a second layer. `COPY --chown` instead: executor 2.3 GB → 1.66 GB.
> - **A smoke assertion hard-coded "cpp is not installed."** True on a bare
>   Windows dev box, false once a fully-equipped executor joins the queue. It
>   now asserts the property that holds either way and prints which it saw.


### 1.1 Terraform — Azure Infrastructure

Create `infra/terraform/` in the repo root:

#### [NEW] `infra/terraform/main.tf`

```hcl
terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
}

resource "azurerm_resource_group" "simulyn" {
  name     = "rg-simulyn"
  location = "southindia"
}

resource "azurerm_container_registry" "acr" {
  name                = "simulynacr"
  resource_group_name = azurerm_resource_group.simulyn.name
  location            = azurerm_resource_group.simulyn.location
  sku                 = "Basic"
  admin_enabled       = true
}

resource "azurerm_kubernetes_cluster" "aks" {
  name                = "aks-simulyn"
  location            = azurerm_resource_group.simulyn.location
  resource_group_name = azurerm_resource_group.simulyn.name
  dns_prefix          = "simulyn"
  sku_tier            = "Free"

  default_node_pool {
    name                = "default"
    node_count          = 1
    vm_size             = "Standard_B2s"
    os_disk_size_gb     = 30
    enable_auto_scaling = true
    min_count           = 1
    max_count           = 3
    temporary_name_for_rotation = "temppool"
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin = "azure"
    load_balancer_sku = "standard"
  }
}

# Attach ACR to AKS so pods can pull images
resource "azurerm_role_assignment" "aks_acr" {
  principal_id         = azurerm_kubernetes_cluster.aks.kubelet_identity[0].object_id
  role_definition_name = "AcrPull"
  scope                = azurerm_container_registry.acr.id
}

output "acr_login_server" {
  value = azurerm_container_registry.acr.login_server
}

output "kube_config" {
  value     = azurerm_kubernetes_cluster.aks.kube_config_raw
  sensitive = true
}

output "cluster_name" {
  value = azurerm_kubernetes_cluster.aks.name
}
```

#### [NEW] `infra/terraform/variables.tf`

```hcl
variable "location" {
  default = "southindia"
}
```

#### [NEW] `infra/terraform/outputs.tf`

```hcl
output "resource_group_name" {
  value = azurerm_resource_group.simulyn.name
}

output "acr_name" {
  value = azurerm_container_registry.acr.name
}

output "aks_cluster_name" {
  value = azurerm_kubernetes_cluster.aks.name
}
```

---

### 1.2 Kubernetes Manifests

Create `infra/k8s/` with plain YAML manifests:

#### [NEW] `infra/k8s/namespace.yaml`

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: simulyn
```

#### [NEW] `infra/k8s/secrets.yaml`

```yaml
# Template — actual values injected by CI/CD or kubectl create secret
apiVersion: v1
kind: Secret
metadata:
  name: simulyn-secrets
  namespace: simulyn
type: Opaque
stringData:
  POSTGRES_USER: "simulyn"
  POSTGRES_PASSWORD: ""          # SET THIS
  JWT_SECRET: ""                 # SET THIS
  JWT_REFRESH_SECRET: ""         # SET THIS
  CLOUD_LLM_API_KEY: ""         # SET THIS
  DATABASE_URL: "postgresql://simulyn:PASSWORD@postgres:5432/simulyn"
```

#### [NEW] `infra/k8s/configmap.yaml`

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: simulyn-config
  namespace: simulyn
data:
  NODE_ENV: "production"
  PORT: "3001"
  CORS_ORIGIN: "https://simulyn.southindia.cloudapp.azure.com"
  NEXT_PUBLIC_API_URL: "https://simulyn.southindia.cloudapp.azure.com/api"
  EXEC_MAX_CONCURRENCY: "20"
  EXEC_TIMEOUT_MS: "8000"
  CLOUD_LLM_PROVIDER: "anthropic"
  CLOUD_LLM_MODEL: "claude-sonnet-5"          # matches the code default
  REDIS_URL: "redis://redis:6379"
```

#### [NEW] `infra/k8s/postgres.yaml`

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-pvc
  namespace: simulyn
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: managed-csi
  resources:
    requests:
      storage: 32Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: simulyn
spec:
  replicas: 1
  strategy:
    type: Recreate          # PVC is RWO — can't attach to two pods
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          ports:
            - containerPort: 5432
          env:
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: simulyn-secrets
                  key: POSTGRES_USER
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: simulyn-secrets
                  key: POSTGRES_PASSWORD
            - name: POSTGRES_DB
              value: "simulyn"
            - name: PGDATA
              value: "/var/lib/postgresql/data/pgdata"
          volumeMounts:
            - name: postgres-storage
              mountPath: /var/lib/postgresql/data
          resources:
            requests:
              cpu: "100m"
              memory: "256Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          livenessProbe:
            exec:
              command: ["pg_isready", "-U", "simulyn", "-d", "simulyn"]
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "simulyn", "-d", "simulyn"]
            initialDelaySeconds: 5
            periodSeconds: 5
      volumes:
        - name: postgres-storage
          persistentVolumeClaim:
            claimName: postgres-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: simulyn
spec:
  selector:
    app: postgres
  ports:
    - port: 5432
      targetPort: 5432
```

#### [NEW] `infra/k8s/redis.yaml`

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: redis-pvc
  namespace: simulyn
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: managed-csi
  resources:
    requests:
      storage: 8Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: simulyn
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
          command: ["redis-server", "--appendonly", "yes", "--maxmemory", "128mb", "--maxmemory-policy", "noeviction"]
          volumeMounts:
            - name: redis-storage
              mountPath: /data
          resources:
            requests:
              cpu: "50m"
              memory: "64Mi"
            limits:
              cpu: "200m"
              memory: "192Mi"
          livenessProbe:
            exec:
              command: ["redis-cli", "ping"]
            periodSeconds: 10
          readinessProbe:
            exec:
              command: ["redis-cli", "ping"]
            periodSeconds: 5
      volumes:
        - name: redis-storage
          persistentVolumeClaim:
            claimName: redis-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: simulyn
spec:
  selector:
    app: redis
  ports:
    - port: 6379
      targetPort: 6379
```

#### [NEW] `infra/k8s/api.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: simulyn
spec:
  replicas: 1
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      initContainers:
        # Run migrations before the API starts
        - name: migrate
          image: REPLACE_WITH_ACR/simulyn-api:latest
          command: ["pnpm", "--filter", "@simulyn/shared", "db:postgres:deploy"]
          envFrom:
            - configMapRef:
                name: simulyn-config
            - secretRef:
                name: simulyn-secrets
      containers:
        - name: api
          image: REPLACE_WITH_ACR/simulyn-api:latest
          ports:
            - containerPort: 3001
          envFrom:
            - configMapRef:
                name: simulyn-config
            - secretRef:
                name: simulyn-secrets
          env:
            - name: REDIS_URL
              value: "redis://redis:6379"
          resources:
            requests:
              cpu: "200m"
              memory: "512Mi"
            limits:
              cpu: "1000m"
              memory: "1Gi"
          livenessProbe:
            httpGet:
              path: /api/docs-json
              port: 3001
            initialDelaySeconds: 30
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /api/docs-json
              port: 3001
            initialDelaySeconds: 10
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: simulyn
spec:
  selector:
    app: api
  ports:
    - port: 3001
      targetPort: 3001
```

#### [NEW] `infra/k8s/web.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: simulyn
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: REPLACE_WITH_ACR/simulyn-web:latest
          ports:
            - containerPort: 3000
          env:
            - name: NODE_ENV
              value: "production"
          resources:
            requests:
              cpu: "100m"
              memory: "256Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          livenessProbe:
            httpGet:
              path: /
              port: 3000
            initialDelaySeconds: 15
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: simulyn
spec:
  selector:
    app: web
  ports:
    - port: 3000
      targetPort: 3000
```

#### [NEW] `infra/k8s/ingress.yaml`

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: simulyn-ingress
  namespace: simulyn
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/websocket-services: "api"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    # Socket.IO needs sticky sessions when multiple API replicas exist
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/session-cookie-name: "simulyn-affinity"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - simulyn.southindia.cloudapp.azure.com
      secretName: simulyn-tls
  rules:
    - host: simulyn.southindia.cloudapp.azure.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  number: 3001
          - path: /socket.io
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  number: 3001
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 3000
```

#### [NEW] `infra/k8s/cert-manager-issuer.yaml`

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: YOUR_EMAIL@university.edu     # CHANGE THIS
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
      - http01:
          ingress:
            class: nginx
```

---

### 1.3 GitHub Actions CI/CD

#### [NEW] `.github/workflows/deploy.yml`

```yaml
name: Build & Deploy to AKS

on:
  push:
    branches: [main]

env:
  ACR_NAME: simulynacr
  ACR_LOGIN_SERVER: simulynacr.azurecr.io
  AKS_CLUSTER: aks-simulyn
  AKS_RESOURCE_GROUP: rg-simulyn

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Log in to Azure
        uses: azure/login@v2
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}

      - name: Log in to ACR
        run: az acr login --name $ACR_NAME

      - name: Build and push API image
        run: |
          docker build -t $ACR_LOGIN_SERVER/simulyn-api:${{ github.sha }} \
                        -t $ACR_LOGIN_SERVER/simulyn-api:latest \
                        -f apps/api/Dockerfile .
          docker push $ACR_LOGIN_SERVER/simulyn-api:${{ github.sha }}
          docker push $ACR_LOGIN_SERVER/simulyn-api:latest

      - name: Build and push Web image
        run: |
          docker build -t $ACR_LOGIN_SERVER/simulyn-web:${{ github.sha }} \
                        -t $ACR_LOGIN_SERVER/simulyn-web:latest \
                        -f apps/web/Dockerfile \
                        --build-arg NEXT_PUBLIC_API_URL=https://simulyn.southindia.cloudapp.azure.com/api .
          docker push $ACR_LOGIN_SERVER/simulyn-web:${{ github.sha }}
          docker push $ACR_LOGIN_SERVER/simulyn-web:latest

      - name: Build and push Executor image
        run: |
          docker build -t $ACR_LOGIN_SERVER/simulyn-executor:${{ github.sha }} \
                        -t $ACR_LOGIN_SERVER/simulyn-executor:latest \
                        -f apps/executor/Dockerfile .
          docker push $ACR_LOGIN_SERVER/simulyn-executor:${{ github.sha }}
          docker push $ACR_LOGIN_SERVER/simulyn-executor:latest

  deploy:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Log in to Azure
        uses: azure/login@v2
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}

      - name: Set AKS context
        uses: azure/aks-set-context@v4
        with:
          resource-group: ${{ env.AKS_RESOURCE_GROUP }}
          cluster-name: ${{ env.AKS_CLUSTER }}

      - name: Update image tags in manifests
        run: |
          sed -i "s|REPLACE_WITH_ACR|$ACR_LOGIN_SERVER|g" infra/k8s/*.yaml
          sed -i "s|:latest|:${{ github.sha }}|g" infra/k8s/api.yaml infra/k8s/web.yaml infra/k8s/executor.yaml

      - name: Apply K8s manifests
        run: |
          kubectl apply -f infra/k8s/namespace.yaml
          kubectl apply -f infra/k8s/configmap.yaml
          kubectl apply -f infra/k8s/postgres.yaml
          kubectl apply -f infra/k8s/redis.yaml
          kubectl apply -f infra/k8s/api.yaml
          kubectl apply -f infra/k8s/web.yaml
          kubectl apply -f infra/k8s/executor.yaml
          kubectl apply -f infra/k8s/ingress.yaml
          kubectl apply -f infra/k8s/cert-manager-issuer.yaml

      - name: Wait for rollout
        run: |
          kubectl -n simulyn rollout status deployment/api --timeout=120s
          kubectl -n simulyn rollout status deployment/web --timeout=120s
          kubectl -n simulyn rollout status deployment/executor --timeout=120s
```

> [!IMPORTANT]
> **GitHub Secrets required**: `AZURE_CREDENTIALS` (service principal JSON), and the K8s secrets should be pre-created on the cluster or managed via a sealed-secrets/external-secrets operator.

---

## Phase 2: Executor Microservice Migration

> [!TIP]
> **Implemented and verified on 2026-08-26.** What actually shipped, where it
> differs from the plan below:
>
> - **Shipped**: `packages/shared/src/execution/` (engine, de-Nested behind an
>   `ExecutorLogger` interface), `packages/shared/src/execution/jobs.ts` (the
>   job contract), the `executor` app with `/healthz` + `/readyz`,
>   `ExecutionQueueService` in the API, `apps/executor/Dockerfile`, `redis` +
>   `executor` services in both compose files, and the Socket.IO Redis adapter.
> - **`/execute/run` and `/execute/trace` go through the queue too.** The plan
>   only moved grading. Leaving raw runs in the API pod would have defeated the
>   point — the Run button and the visualiser accept arbitrary code. Both now
>   enqueue a `RawRunJob`.
> - **Submissions stayed synchronous.** The sequence diagram below shows
>   `202 Accepted` plus a Socket.IO result push. What shipped holds the request
>   open on `waitUntilFinished` instead, so no frontend change was needed and
>   the existing suites kept passing. The async flow is still the right move
>   once grading gets slow enough to time out an HTTP request; §2.2's frontend
>   section describes it.
> - **The queue is optional.** With `REDIS_URL` unset the API runs jobs
>   in-process, and if an enqueue fails it falls back rather than erroring.
>   Both modes are verified.
> - **`BullModule.registerQueue()` is required in the worker's module.** The
>   `@Processor` decorator alone marks the class but never starts a BullMQ
>   worker — the executor sat idle through 0 jobs until this was added.
> - **The executor needs its own port var.** It inherited `PORT=3001` from the
>   root `.env` and collided with the API; it reads `EXECUTOR_PORT` (3002).
> - **Verified**: 135 checks (96 smoke + 23 features + 16 hidden-leak) pass in
>   both queue and inline mode; the executor logged 36 `run` and 25 `grade`
>   jobs with 0 fallbacks.


### 2.1 Architecture Changes

The core change: **extract the code execution engine from the API into a standalone microservice** that communicates via BullMQ (Redis).

```mermaid
sequenceDiagram
    participant Student as Student Browser
    participant API as API Pod
    participant Redis as Redis (BullMQ)
    participant Executor as Executor Pod

    Student->>API: POST /submissions {code, language, problemId}
    API->>API: Validate, create Submission (PENDING)
    API->>Redis: enqueue job {submissionId, code, language, testCases, harnessSpec}
    API->>Student: 202 Accepted {submissionId}
    API->>API: Update Submission → RUNNING

    Redis->>Executor: dequeue job
    Executor->>Executor: prepare(code, language)
    loop Each test case
        Executor->>Executor: guardedRun(input, timeout)
    end
    Executor->>Redis: complete job {results[], passedCount, compileError?}

    Redis->>API: BullMQ completed event
    API->>API: Save TestResults, calculate score
    API->>API: Update Submission → COMPLETED
    API->>Student: Socket.IO emit("submission-result", {...})
```

### 2.2 Code Refactoring Plan

#### Move shared execution code to `packages/shared`

Move these files from `apps/api/src/modules/execution/` to `packages/shared/src/execution/`:
- `executor.ts` — Toolchain discovery, `prepare()`, `spawnOnce()`, `guardedRun()`
- `harness.ts` — `buildProgram()`, harness spec types, `RESULT_MARKER`
- `compare.ts` — `outputsMatch()`, float epsilon, normalization
- `semaphore.ts` — Counting semaphore (owned by `Executor`; see the concurrency note below)
- `trace.types.ts` — `TRACE_MARKER`, `MAX_TRACE_EVENTS`, `TraceEvent`, `TraceResult`. **Required**: `harness.ts` imports from it, so moving harness without it will not compile.
- `splitDriverOutput()` and `extractTraceEvents()` — from `execution.service.ts`

> [!IMPORTANT]
> **`executor.ts` is not dependency-free today.** Its first line is
> `import { Logger } from '@nestjs/common'`. Before it can live in
> `packages/shared`, replace that with an injectable logger callback (or plain
> `console`), otherwise the shared package gains a NestJS runtime dependency
> that the web app would also pull in. The other four files are clean.
>
> **`maskHiddenOutcome()` must stay in the API**, not move to shared. It is the
> security boundary that stops a student reading hidden test cases out of
> `stdout`, `stderr` or the exit code, and the executor must never be the
> component deciding what a student is allowed to see. The executor returns raw
> output for every case; the API masks before responding. See
> `apps/api/test/hidden-leak.mjs` for the exploits this blocks.

**Export from** `packages/shared/src/index.ts`:
```typescript
export * from './execution/executor';
export * from './execution/harness';
export * from './execution/compare';
export * from './execution/semaphore';
export * from './execution/trace.types';
```

---

#### [NEW] `apps/executor/` — NestJS Microservice

**Directory structure:**
```
apps/executor/
├── Dockerfile
├── package.json
├── tsconfig.json
├── tsconfig.build.json
└── src/
    ├── main.ts                  # NestJS bootstrap (microservice mode)
    ├── app.module.ts            # BullModule.forRoot() + ExecutorModule
    ├── executor/
    │   ├── executor.module.ts
    │   ├── executor.processor.ts   # @Processor('code-execution') — the BullMQ worker
    │   └── executor.health.ts      # Health check endpoint for K8s probes
    └── config/
        └── configuration.ts     # REDIS_URL, EXEC_MAX_CONCURRENCY, EXEC_TIMEOUT_MS
```

**Key file: `executor.processor.ts`**:
```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Executor, buildProgram, outputsMatch, splitDriverOutput, Semaphore } from '@simulyn/shared';

interface ExecutionJob {
  submissionId: string;
  code: string;
  language: 'python' | 'javascript' | 'cpp' | 'java';
  testCases: Array<{ id: string; input: string; expected: string; isHidden: boolean }>;
  harnessSpec: HarnessSpec;
  timeoutMs: number;
}

interface ExecutionResult {
  submissionId: string;
  compileError?: string;
  results: Array<{
    testCaseId: string;
    passed: boolean;
    actual: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    executionMs: number;
    timedOut: boolean;
  }>;
}

// `Executor` already owns a Semaphore sized by its constructor argument, so do
// NOT wrap `run()` in a second one — that double-limits and makes the effective
// concurrency min(processor, outer semaphore, Executor's own).
@Processor('code-execution', { concurrency: 5 })
export class ExecutorProcessor extends WorkerHost {
  private executor = new Executor(
    parseInt(process.env.EXEC_MAX_CONCURRENCY || '20', 10),
  );

  async process(job: Job<ExecutionJob>): Promise<ExecutionResult> {
    const { submissionId, code, language, testCases, harnessSpec, timeoutMs } = job.data;

    // Build the harnessed program. Omitting the 4th argument (testInput) puts
    // the driver in stdin mode, so one compile serves every test case.
    const fullCode = buildProgram(language, code, harnessSpec);

    // Signature is prepare(lang, program, options) — language first.
    const prepared = await this.executor.prepare(language, fullCode, { timeoutMs });

    // prepare() REPORTS a compile error, it does not throw. Check the field.
    if (prepared.compileError) {
      await prepared.dispose();
      return { submissionId, compileError: prepared.compileError, results: [] };
    }

    try {
      const results = [];
      for (const tc of testCases) {
        const result = await prepared.run(tc.input, { timeoutMs });
        const { actual, studentOutput } = splitDriverOutput(result.stdout);
        const passed =
          !result.timedOut &&
          result.exitCode === 0 &&
          outputsMatch(actual, tc.expected, harnessSpec.normalize);

        results.push({
          testCaseId: tc.id,
          passed,
          actual,
          stdout: studentOutput,
          stderr: result.stderr,
          exitCode: result.exitCode,
          executionMs: result.executionMs,
          timedOut: result.timedOut,
        });

        // Report progress
        await job.updateProgress(Math.round(((results.length) / testCases.length) * 100));
      }

      return { submissionId, results };
    } finally {
      await prepared.dispose();
    }
  }
}
```

---

#### Modify `apps/api/` — Queue Producer

**Changes to `apps/api/src/modules/submissions/submissions.service.ts`:**

Replace the direct `this.executionService.evaluateProblem()` call with BullMQ enqueue:

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class SubmissionsService {
  constructor(
    @InjectQueue('code-execution') private executionQueue: Queue,
    // ... existing deps
  ) {}

  async create(userId: string, dto: CreateSubmissionDto) {
    // ... existing validation, create submission as PENDING ...

    // Enqueue for executor pool instead of running in-process
    const job = await this.executionQueue.add('evaluate', {
      submissionId: submission.id,
      code: dto.code,
      language: dto.language,
      testCases: problem.testCases.map(tc => ({
        id: tc.id,
        input: tc.input,
        expected: tc.expected,
        isHidden: tc.isHidden,
      })),
      harnessSpec: JSON.parse(problem.harness),  // column is `harness`
      timeoutMs: this.config.execTimeoutMs,
    }, {
      priority: dto.examAttemptId ? 1 : 10,  // Exam submissions get higher priority
      attempts: 2,
      backoff: { type: 'exponential', delay: 1000 },
    });

    // Update to RUNNING
    await this.prisma.submission.update({
      where: { id: submission.id },
      data: { status: 'RUNNING' },
    });

    // Return immediately — result comes via BullMQ event listener
    return submission;
  }
}
```

**New: `apps/api/src/modules/submissions/submissions.listener.ts`:**

```typescript
import { OnQueueEvent, QueueEventsHost, QueueEventsListener } from '@nestjs/bullmq';

@QueueEventsListener('code-execution')
export class SubmissionsListener extends QueueEventsHost {
  constructor(
    private prisma: PrismaService,
    private gamification: GamificationService,
    private proctoring: ProctoringGateway,
  ) { super(); }

  @OnQueueEvent('completed')
  async onCompleted({ jobId, returnvalue }: { jobId: string; returnvalue: string }) {
    const result: ExecutionResult = JSON.parse(returnvalue);

    // Save test results, calculate score, update submission to COMPLETED
    // ... (same logic currently in SubmissionsService.create, after evaluateProblem)
    //
    // The executor returns raw stdout/stderr/exitCode for EVERY case, hidden
    // ones included. Persist that, but run maskHiddenOutcome() over the payload
    // before it reaches a student — both here and on GET /submissions/:id.

    // Emit result via Socket.IO
    this.proctoring.emitSubmissionResult(result.submissionId, /* ... */);
  }

  @OnQueueEvent('failed')
  async onFailed({ jobId, failedReason }: { jobId: string; failedReason: string }) {
    // Mark submission as ERROR
  }
}
```

---

#### Modify `apps/web/` — the POST response is no longer the result

> [!WARNING]
> This is a **breaking API change** and the plan above does not account for it.
> `POST /submissions` currently returns the fully graded submission, and the
> frontend renders straight from that response. Making it return `202 Accepted`
> without the matching client work leaves both pages showing nothing.

Today both call sites `await` the POST and read the graded fields directly:

| File | Reads from the response |
|---|---|
| `apps/web/src/app/student/problems/[id]/page.tsx` | `testResults`, `passedCount`, `totalCount`, `compileError`, `passed`, `score`, `reward` (XP toast, level-up, new badges) |
| `apps/web/src/app/student/exams/[id]/page.tsx` | the same, minus `reward`, plus per-question `submitted`/`passed` state |

Required changes:

1. **Subscribe before submitting.** Join a per-user Socket.IO room on mount and
   listen for `submission-result`; the POST only returns `{ submissionId }`.
2. **Show a pending state.** The Test Results panel needs a third state between
   "no results" and "results" — a queued/running indicator keyed to the
   submission id, with the existing skeleton treatment.
3. **Handle the result arriving out of band**, including while the student has
   navigated to another question in an exam.
4. **Keep a fallback path.** If the socket is down, poll `GET /submissions/:id`
   until `status` leaves `PENDING`/`RUNNING` — otherwise a dropped socket means
   a submission that never visibly completes.
5. **Exam scoring is affected.** `recalculateAttemptScore()` runs after grading,
   so an exam submitted seconds after the last answer can score before that
   answer is graded. Either await outstanding jobs on exam submit, or
   recalculate again on each `completed` event for that attempt.

Budget this as its own task — it is comparable in size to the executor service
itself, and skipping it silently breaks the core student flow.

---

#### Modify `apps/api/` — Socket.IO Redis Adapter

**Changes to `apps/api/src/modules/proctoring/proctoring.gateway.ts`:**

Add Redis adapter for multi-pod Socket.IO:

```typescript
// In the gateway or a separate adapter provider:
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';

export class RedisIoAdapter extends IoAdapter {
  createIOServer(port: number, options?: any) {
    const server = super.createIOServer(port, options);
    const pubClient = createClient({ url: process.env.REDIS_URL });
    const subClient = pubClient.duplicate();
    Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
      server.adapter(createAdapter(pubClient, subClient));
    });
    return server;
  }
}

// In main.ts:
app.useWebSocketAdapter(new RedisIoAdapter(app));
```

---

#### [NEW] `apps/executor/Dockerfile`

```dockerfile
# ── Build stage ──
FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/executor/package.json apps/executor/
COPY packages/shared/package.json packages/shared/
RUN corepack enable && pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/executor apps/executor
RUN pnpm --filter @simulyn/shared build && pnpm --filter executor build
RUN pnpm deploy --filter executor --prod /app/deployed

# ── Runtime stage ──
FROM node:20-alpine AS runner
RUN apk add --no-cache dumb-init python3 g++ libstdc++ openjdk17-jdk \
    && ln -sf /usr/bin/python3 /usr/bin/python

ENV PYTHON_BIN=/usr/bin/python3 \
    CXX_BIN=/usr/bin/g++ \
    JAVAC_BIN=/usr/lib/jvm/java-17-openjdk/bin/javac \
    JAVA_BIN=/usr/lib/jvm/java-17-openjdk/bin/java \
    NODE_ENV=production

RUN addgroup -S simulyn && adduser -S simulyn -G simulyn
WORKDIR /app
COPY --from=builder --chown=simulyn:simulyn /app/deployed .
USER simulyn

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
```

---

#### [NEW] `infra/k8s/executor.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: executor
  namespace: simulyn
spec:
  replicas: 2        # Base pool size
  selector:
    matchLabels:
      app: executor
  template:
    metadata:
      labels:
        app: executor
    spec:
      containers:
        - name: executor
          image: REPLACE_WITH_ACR/simulyn-executor:latest
          env:
            - name: REDIS_URL
              value: "redis://redis:6379"
            - name: EXEC_MAX_CONCURRENCY
              value: "20"
            - name: EXEC_TIMEOUT_MS
              value: "8000"
          resources:
            requests:
              cpu: "200m"
              memory: "512Mi"
            limits:
              cpu: "1000m"
              memory: "1Gi"
          # Executor pods have NO network egress (student code can't phone home)
          securityContext:
            runAsNonRoot: true
            readOnlyRootFilesystem: false  # Need /tmp for compilation
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          livenessProbe:
            httpGet:
              path: /health
              port: 3002
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /health
              port: 3002
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: executor
  namespace: simulyn
spec:
  selector:
    app: executor
  ports:
    - port: 3002
      targetPort: 3002
---
# Network Policy: executor pods can ONLY talk to Redis, nothing else
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: executor-isolation
  namespace: simulyn
spec:
  podSelector:
    matchLabels:
      app: executor
  policyTypes: [Ingress, Egress]
  ingress: []            # No inbound traffic needed
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: redis
      ports:
        - port: 6379
    # Allow DNS resolution
    - to: []
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
---
# HPA: scale executor pods 2→8 based on CPU utilization
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: executor-hpa
  namespace: simulyn
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: executor
  minReplicas: 2
  maxReplicas: 8
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30   # Scale up fast for exam peaks
      policies:
        - type: Pods
          value: 3
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300  # Scale down slowly (5 min cooldown)
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120
```

---

### 2.3 New npm Dependencies

#### `apps/api/package.json` — add:
```json
{
  "@nestjs/bullmq": "^10.0.0",
  "bullmq": "^5.0.0",
  "@socket.io/redis-adapter": "^8.0.0",
  "redis": "^4.0.0"
}
```

#### `apps/executor/package.json` — new:
```json
{
  "name": "executor",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/bullmq": "^10.0.0",
    "bullmq": "^5.0.0",
    "@simulyn/shared": "workspace:*"
  }
}
```

---

## Phase 3: Post-Deployment Setup Checklist

> [!TIP]
> **Superseded by `infra/README.md`** (2026-08-27), which carries the corrected
> commands plus verification, backup/restore and capacity sections. The steps
> below are kept for reference; where they disagree, the README is right. In
> particular the checklist's step 7 (`kubectl apply -f infra/k8s/`) would
> overwrite the secret created in step 6, and its step 8 seeds via
> `db:seed`, which resolves the SQLite schema rather than the Postgres one.


### First-Time Azure Setup (manual, one-time)
1. `az login`
2. `cd infra/terraform && terraform init && terraform apply`
3. `az aks get-credentials --resource-group rg-simulyn --name aks-simulyn`
4. Install NGINX Ingress Controller:
   ```bash
   helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
   helm install ingress-nginx ingress-nginx/ingress-nginx \
     --namespace ingress-nginx --create-namespace \
     --set controller.service.annotations."service\.beta\.kubernetes\.io/azure-dns-label-name"=simulyn
   ```
5. Install cert-manager:
   ```bash
   kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.15.0/cert-manager.yaml
   ```
6. Create K8s secrets:
   ```bash
   kubectl -n simulyn create secret generic simulyn-secrets \
     --from-literal=POSTGRES_USER=simulyn \
     --from-literal=POSTGRES_PASSWORD='STRONG_PASSWORD_HERE' \
     --from-literal=JWT_SECRET='RANDOM_SECRET_HERE' \
     --from-literal=JWT_REFRESH_SECRET='RANDOM_SECRET_HERE' \
     --from-literal=CLOUD_LLM_API_KEY='YOUR_API_KEY' \
     --from-literal=DATABASE_URL='postgresql://simulyn:STRONG_PASSWORD_HERE@postgres:5432/simulyn'
   ```
7. Apply manifests: `kubectl apply -f infra/k8s/`
8. Seed database:
   ```bash
   kubectl -n simulyn exec deployment/api -- pnpm --filter @simulyn/shared db:seed
   ```

### Configure GitHub Actions Secrets
- `AZURE_CREDENTIALS` — Service principal JSON from `az ad sp create-for-rbac`

### Post-Deployment Database Backup Strategy
Since you chose self-hosted PostgreSQL (cheapest option), set up a CronJob for automated backups:

```yaml
# infra/k8s/pg-backup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: postgres-backup
  namespace: simulyn
spec:
  schedule: "0 2 * * *"    # Daily at 2 AM IST
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: backup
              image: postgres:16-alpine
              command:
                - /bin/sh
                - -c
                - |
                  pg_dump -h postgres -U $POSTGRES_USER -d simulyn | gzip > /backups/simulyn-$(date +%Y%m%d).sql.gz
                  # Keep only last 7 days
                  find /backups -name "*.sql.gz" -mtime +7 -delete
              envFrom:
                - secretRef:
                    name: simulyn-secrets
              volumeMounts:
                - name: backup-storage
                  mountPath: /backups
          restartPolicy: OnFailure
          volumes:
            - name: backup-storage
              persistentVolumeClaim:
                claimName: postgres-backup-pvc
```

---

## Verification Plan

### Automated Tests
```bash
# After deployment, port-forward and run existing test suites:
kubectl -n simulyn port-forward svc/api 3001:3001
pnpm db:seed && pnpm --filter api test:smoke
pnpm db:seed && pnpm --filter api test:phase5
pnpm db:seed && pnpm --filter api test:features
pnpm db:seed && pnpm --filter api test:termination
pnpm db:seed && pnpm --filter api test:leak
```

### Manual Verification
1. Access `https://simulyn.southindia.cloudapp.azure.com` — verify TLS certificate is valid
2. Log in as each demo role (admin, teacher, student) — verify auth works
3. Submit code in all 4 languages — verify execution via executor pods
4. Start an exam, submit during exam — verify proctoring WebSocket works
5. Trigger concurrent submissions (simulate exam peak) — verify HPA scales executor pods
6. Check `kubectl -n simulyn logs deployment/executor` — verify queue processing
7. Verify Network Policy: exec into executor pod and confirm no outbound internet access
