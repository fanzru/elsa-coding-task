# Real-time vocabulary quiz — developer entry points.
# `make` or `make help` lists the targets. Every target is a thin wrapper over pnpm scripts,
# so the commands in README.md work with or without make.

SHELL := /bin/bash
.DEFAULT_GOAL := help

REDIS_PORT   ?= 6390
REDIS_URL    ?= redis://127.0.0.1:$(REDIS_PORT)
PG_PORT      ?= 5439
DATABASE_URL      ?= postgres://quiz:quiz@127.0.0.1:$(PG_PORT)/quiz
TEST_DATABASE_URL ?= postgres://quiz:quiz@127.0.0.1:$(PG_PORT)/quiz_test
WEB_PORT     ?= 3000
SERVER_PORT  ?= 4000
CLIENTS      ?= 1000
WORKERS      ?= 8

.PHONY: help install dev dev-server dev-web build start test test-redis test-watch lint lint-fix \
        typecheck check load redis-up redis-down pg-up pg-down test-full db-migrate db-migrate-down db-seed \
        cluster cluster-down docker-build tag clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage: make <target> [VAR=value]\n\nTargets:\n"} \
	  /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 } \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)
	@printf "\nVariables: WEB_PORT=$(WEB_PORT) SERVER_PORT=$(SERVER_PORT) CLIENTS=$(CLIENTS) WORKERS=$(WORKERS) DATABASE_URL=$(DATABASE_URL) REDIS_URL=$(REDIS_URL)\n\n"

##@ Setup
install: ## Install all workspace dependencies
	pnpm install

##@ Run
dev: pg-up ## Run Postgres (Docker), server (:4000) and web (:3000) with live reload; WEB_PORT/SERVER_PORT to change
	DATABASE_URL=$(DATABASE_URL) PORT=$(SERVER_PORT) pnpm --filter @quiz/server dev & \
	pnpm --filter @quiz/web exec next dev -p $(WEB_PORT); kill %1 2>/dev/null

dev-server: pg-up ## Run only the quiz server (starts Postgres in Docker if needed)
	DATABASE_URL=$(DATABASE_URL) PORT=$(SERVER_PORT) pnpm --filter @quiz/server dev

dev-web: ## Run only the web client
	pnpm --filter @quiz/web exec next dev -p $(WEB_PORT)

build: ## Production build (server → dist/, web → .next/)
	pnpm build

start: build pg-up ## Build, then run the production server and web
	DATABASE_URL=$(DATABASE_URL) PORT=$(SERVER_PORT) NODE_ENV=production node apps/server/dist/index.js & \
	pnpm --filter @quiz/web exec next start -p $(WEB_PORT); kill %1 2>/dev/null

##@ Quality
test: pg-up ## Unit, property, actor and integration tests against the throwaway Postgres (cluster tests need Redis)
	DATABASE_URL=$(TEST_DATABASE_URL) pnpm test

test-redis: redis-up pg-up ## Test suite including cluster tests against a throwaway Redis
	REDIS_URL=$(REDIS_URL) DATABASE_URL=$(TEST_DATABASE_URL) pnpm test; status=$$?; $(MAKE) redis-down; exit $$status

test-full: redis-up pg-up ## Everything, then stop Redis and Postgres
	REDIS_URL=$(REDIS_URL) DATABASE_URL=$(TEST_DATABASE_URL) pnpm test; status=$$?; $(MAKE) redis-down pg-down; exit $$status

test-watch: ## Server tests in watch mode
	pnpm --filter @quiz/server test:watch

lint: ## Biome lint + format check
	pnpm lint

lint-fix: ## Apply Biome fixes
	pnpm lint:fix

typecheck: ## tsc --noEmit for every package
	pnpm typecheck

check: lint typecheck test ## Everything CI runs (cluster tests need Redis: make test-redis)

##@ Performance
load: ## Load test a running server: make load CLIENTS=2000 WORKERS=8 [SERVER_PORT=4000]
	pnpm test:load -- --url ws://localhost:$(SERVER_PORT)/ws --clients $(CLIENTS) --workers $(WORKERS)

##@ Database (Postgres)
pg-up: ## Start Postgres in Docker (PG_PORT, default 5439; user/pass quiz; dbs quiz and quiz_test)
	@docker ps --format '{{.Names}}' | grep -q '^quiz-postgres$$' || \
	  docker run --rm -d --name quiz-postgres -p 127.0.0.1:$(PG_PORT):5432 \
	    -e POSTGRES_USER=quiz -e POSTGRES_PASSWORD=quiz -e POSTGRES_DB=quiz postgres:17-alpine >/dev/null
	@for i in $$(seq 1 30); do docker exec quiz-postgres pg_isready -U quiz -q 2>/dev/null && break; sleep 0.5; done
	@docker exec quiz-postgres createdb -U quiz quiz_test 2>/dev/null || true
	@echo "postgres ready: dev $(DATABASE_URL) · tests $(TEST_DATABASE_URL)"

pg-down: ## Stop Postgres (its data is gone with the container)
	@docker stop quiz-postgres >/dev/null 2>&1 || true

db-migrate: ## Apply pending migrations (uses DATABASE_URL, or apps/server/.env)
	pnpm --filter @quiz/server db:migrate

db-migrate-down: ## Roll back the last migration
	pnpm --filter @quiz/server db:migrate:down

db-seed: ## Upsert data/quizzes.json into the quiz bank
	pnpm --filter @quiz/server db:seed

##@ Cluster (Redis)
redis-up: ## Start a throwaway Redis in Docker (REDIS_PORT, default 6390)
	@docker ps --format '{{.Names}}' | grep -q '^quiz-redis$$' || \
	  docker run --rm -d --name quiz-redis -p 127.0.0.1:$(REDIS_PORT):6379 redis:7-alpine >/dev/null
	@echo "redis ready at $(REDIS_URL)"

redis-down: ## Stop the throwaway Redis
	@docker stop quiz-redis >/dev/null 2>&1 || true

cluster: ## Two server instances + Redis + web via Docker Compose
	docker compose up --build

cluster-down: ## Stop the Compose stack
	docker compose down

##@ Release
docker-build: ## Build both production images locally (quiz-server, quiz-web)
	docker build -f apps/server/Dockerfile -t quiz-server:local .
	docker build -f apps/web/Dockerfile -t quiz-web:local .

tag: ## Create and push an annotated release tag: make tag VERSION=v0.1.0 (triggers the Release workflow)
	@[[ "$(VERSION)" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$$ ]] || { echo "VERSION must look like v0.1.0"; exit 1; }
	@git diff --quiet && git diff --cached --quiet || { echo "working tree not clean"; exit 1; }
	git tag -a "$(VERSION)" -m "Release $(VERSION)"
	git push origin "$(VERSION)"

##@ Housekeeping
clean: ## Remove build output and test artefacts
	rm -rf apps/server/dist apps/web/.next apps/server/loadtest-results apps/web/tsconfig.tsbuildinfo
