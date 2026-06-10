# remote-helper build tasks. All binaries are fully static (CGO_ENABLED=0).

VERSION ?= 0.1.0
PROTOCOL_VERSION ?= 1
DIST := dist
LDFLAGS := -s -w -X main.Version=$(VERSION)

.PHONY: all build test vet fmt clean dist

all: vet test build

# Build a native binary into dist/ for the host platform.
build:
	@mkdir -p $(DIST)
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o $(DIST)/helper .

vet:
	go vet ./...

fmt:
	gofmt -w .

test:
	go test ./...

# Cross-compile all release targets and write dist/manifest.json.
dist:
	VERSION=$(VERSION) PROTOCOL_VERSION=$(PROTOCOL_VERSION) ./build.sh

clean:
	rm -rf $(DIST)
