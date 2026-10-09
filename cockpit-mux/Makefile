.PHONY: build build-shadow build-artifact test test-unit test-shadow provision-libghostty

LIBGHOSTTY_TARGET ?= native
LIBGHOSTTY_PREFIX ?= $(CURDIR)/.build/libghostty-vt/$(LIBGHOSTTY_TARGET)
LIBGHOSTTY_PKGCONFIG ?= $(LIBGHOSTTY_PREFIX)/share/pkgconfig
BIN ?= $(CURDIR)/bin/cockpit-mux
VERSION ?= 0.1.41
SOURCE_HASH ?= dev
BUILD_LDFLAGS = -X main.Version=$(VERSION) -X main.SourceHash=$(SOURCE_HASH)

build: provision-libghostty
	mkdir -p "$(dir $(BIN))"
	PKG_CONFIG_PATH="$(LIBGHOSTTY_PKGCONFIG):$${PKG_CONFIG_PATH:-}" go build -tags libghostty -ldflags "$(BUILD_LDFLAGS)" -o "$(BIN)" ./cmd/cockpit-mux

build-shadow: build

# Produces one explicitly named release artifact. Callers provide the already
# validated Ghostty/Zig target and Go target; no existing artifact is replaced.
build-artifact: provision-libghostty
	@test -n "$(GOOS)" && test -n "$(GOARCH)" && test -n "$(ARTIFACT)" || (echo "GOOS, GOARCH, and ARTIFACT are required" >&2; exit 2)
	@test ! -e "$(ARTIFACT)" || (echo "refusing to replace existing artifact: $(ARTIFACT)" >&2; exit 1)
	mkdir -p "$(dir $(ARTIFACT))"
	CGO_ENABLED=1 GOOS="$(GOOS)" GOARCH="$(GOARCH)" PKG_CONFIG_PATH="$(LIBGHOSTTY_PKGCONFIG):$${PKG_CONFIG_PATH:-}" go build -tags libghostty -ldflags "$(BUILD_LDFLAGS)" -o "$(ARTIFACT)" ./cmd/cockpit-mux

test: build test-unit test-shadow

test-unit:
	go test ./...

# Fetches and builds the pinned Ghostty revision without touching a system
# installation. See scripts/build-libghostty-vt.sh for the no-cleanup policy.
provision-libghostty:
	LIBGHOSTTY_TARGET="$(LIBGHOSTTY_TARGET)" LIBGHOSTTY_PREFIX="$(LIBGHOSTTY_PREFIX)" bash scripts/build-libghostty-vt.sh

test-shadow: provision-libghostty
	PKG_CONFIG_PATH="$(LIBGHOSTTY_PKGCONFIG):$${PKG_CONFIG_PATH:-}" go test -tags libghostty ./daemon
