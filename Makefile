.PHONY: api-lint dev build check test

api-lint:
	npm run api-lint

dev:
	npm run dev

build:
	npm run build

check:
	npm run check

test:
	npm test

.PHONY: adapters-test adapters-build
adapters-test:
	go test -race ./...
	go vet ./...
	node --test internal/plugins/plugins.test.mjs

adapters-build:
	go build -o bin/aap ./cmd/aap
