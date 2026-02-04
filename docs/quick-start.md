# Quick Start Guide

Get the Workflow Builder running in under 10 minutes.

## Prerequisites

- Docker installed
- Kubernetes cluster (Kind recommended for local dev)
- kubectl configured
- Dapr CLI installed
- pnpm installed

## 1. Clone and Setup

```bash
git clone https://github.com/PittampalliOrg/workflow-builder.git
cd workflow-builder
git checkout feature/dapr-workflow-infrastructure
pnpm install
```

## 2. Start Local Kubernetes (Kind)

```bash
# Create cluster with ingress support
kind create cluster --config=- <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - containerPort: 80
        hostPort: 80
      - containerPort: 443
        hostPort: 443
  - role: worker
  - role: worker
EOF
```

## 3. Install Dapr

```bash
# Install Dapr CLI
curl -fsSL https://raw.githubusercontent.com/dapr/cli/master/install/install.sh | bash

# Initialize Dapr on Kubernetes
dapr init -k --wait

# Verify installation
dapr status -k
```

## 4. Deploy Infrastructure

```bash
# Create namespace
kubectl create namespace workflow-builder

# Deploy Redis (for Dapr state store)
kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: workflow-builder
spec:
  replicas: 1
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
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: workflow-builder
spec:
  selector:
    app: redis
  ports:
    - port: 6379
EOF

# Deploy PostgreSQL
kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql
  namespace: workflow-builder
spec:
  serviceName: postgresql
  replicas: 1
  selector:
    matchLabels:
      app: postgresql
  template:
    metadata:
      labels:
        app: postgresql
    spec:
      containers:
        - name: postgresql
          image: postgres:16-alpine
          env:
            - name: POSTGRES_DB
              value: workflow_builder
            - name: POSTGRES_PASSWORD
              value: password
          ports:
            - containerPort: 5432
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 1Gi
---
apiVersion: v1
kind: Service
metadata:
  name: postgresql
  namespace: workflow-builder
spec:
  clusterIP: None
  selector:
    app: postgresql
  ports:
    - port: 5432
EOF

# Wait for PostgreSQL
kubectl wait --for=condition=ready pod/postgresql-0 -n workflow-builder --timeout=120s
```

## 5. Configure Secrets

```bash
kubectl create secret generic workflow-builder-secrets \
  --from-literal=DATABASE_URL=postgresql://postgres:password@postgresql:5432/workflow_builder \
  --from-literal=BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  --from-literal=INTEGRATION_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -n workflow-builder
```

## 6. Run Database Migrations

```bash
# Port-forward to PostgreSQL
kubectl port-forward svc/postgresql 5432:5432 -n workflow-builder &

# Run migrations
DATABASE_URL="postgresql://postgres:password@localhost:5432/workflow_builder" pnpm db:migrate

# Seed built-in functions
DATABASE_URL="postgresql://postgres:password@localhost:5432/workflow_builder" pnpm seed-functions

# Stop port-forward
pkill -f "kubectl port-forward.*postgresql"
```

## 7. Build and Deploy Services

```bash
# Build Docker images
docker build -t workflow-orchestrator -f services/workflow-orchestrator/Dockerfile services/workflow-orchestrator/
docker build -t function-runner -f services/function-runner/Dockerfile .

# Load images into Kind
kind load docker-image workflow-orchestrator:latest
kind load docker-image function-runner:latest

# Deploy services
kubectl apply -k k8s/knative/
```

## 8. Verify Deployment

```bash
# Check pods
kubectl get pods -n workflow-builder

# Expected output:
# NAME                                    READY   STATUS
# function-runner-xxx                     2/2     Running
# postgresql-0                            1/1     Running
# redis-xxx                               1/1     Running
# workflow-orchestrator-xxx               2/2     Running

# Test orchestrator health
kubectl run test --rm -it --image=curlimages/curl -n workflow-builder -- \
  curl -s http://workflow-orchestrator:8080/healthz

# Test function-runner status
kubectl run test --rm -it --image=curlimages/curl -n workflow-builder -- \
  curl -s http://function-runner:8080/status
```

## 9. Run Your First Workflow

```bash
# Execute a simple HTTP request workflow
kubectl run test --rm -it --image=curlimages/curl -n workflow-builder -- \
  curl -s -X POST http://workflow-orchestrator:8080/api/v2/workflows \
  -H "Content-Type: application/json" \
  -d '{
    "definition": {
      "id": "hello-world",
      "name": "Hello World Workflow",
      "version": "1.0.0",
      "nodes": [
        {
          "id": "trigger-1",
          "type": "trigger",
          "label": "Start",
          "enabled": true,
          "position": {"x": 0, "y": 0},
          "config": {}
        },
        {
          "id": "action-1",
          "type": "action",
          "label": "Get UUID",
          "enabled": true,
          "position": {"x": 200, "y": 0},
          "config": {
            "actionId": "system/http-request",
            "url": "https://httpbin.org/uuid",
            "method": "GET"
          }
        }
      ],
      "edges": [{"id": "e1", "source": "trigger-1", "target": "action-1"}],
      "executionOrder": ["action-1"]
    },
    "triggerData": {"hello": "world"}
  }'

# You'll get back an instanceId like:
# {"instanceId":"hello-world-1234567890-abc123","status":"started"}
```

## 10. Check Workflow Result

```bash
# Replace with your instanceId
INSTANCE_ID="hello-world-1234567890-abc123"

# Wait and check status
sleep 5
kubectl run test --rm -it --image=curlimages/curl -n workflow-builder -- \
  curl -s "http://workflow-orchestrator:8080/api/v2/workflows/${INSTANCE_ID}/status"

# Expected output:
# {"phase":"completed","outputs":{"action-1":{"success":true,"data":{"uuid":"..."}}}}
```

## Next Steps

1. **Start the UI**: Run `pnpm dev` to start the visual workflow builder
2. **Add Integrations**: Configure API keys in the integrations page
3. **Create Custom Functions**: See [Adding Custom Functions](./architecture.md#adding-custom-functions)
4. **Deploy to Production**: Follow the [Deployment Guide](./architecture.md#deployment)

## Troubleshooting

### Pods not starting
```bash
kubectl describe pod -l app.kubernetes.io/name=workflow-orchestrator -n workflow-builder
kubectl logs -l app.kubernetes.io/name=workflow-orchestrator -n workflow-builder --all-containers
```

### Database connection issues
```bash
kubectl exec -it postgresql-0 -n workflow-builder -- psql -U postgres -d workflow_builder -c "SELECT 1"
```

### Dapr sidecar not injecting
```bash
# Verify Dapr is installed
dapr status -k

# Check namespace has Dapr injection enabled (should be automatic)
kubectl get pods -n workflow-builder -o jsonpath='{.items[*].spec.containers[*].name}' | tr ' ' '\n' | grep daprd
```

## Clean Up

```bash
# Delete everything
kubectl delete namespace workflow-builder
kind delete cluster
```
