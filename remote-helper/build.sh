#!/usr/bin/env bash
# Build fully static remote-helper binaries for all supported targets and emit
# a dist/manifest.json describing them. CGO is disabled for static linkage.
set -euo pipefail

cd "$(dirname "$0")"

VERSION="${VERSION:-0.1.0}"
PROTOCOL_VERSION="${PROTOCOL_VERSION:-1}"
DIST="dist"

# os/arch targets to build.
TARGETS=(
  "linux/amd64"
  "linux/arm64"
  "darwin/arm64"
)

rm -rf "${DIST}"
mkdir -p "${DIST}"

# sha256 helper that works on both macOS and Linux.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Compute a stable source hash over the Go source files and go.mod. This is
# embedded into every binary via -ldflags and recorded in the manifest so the
# provisioner can compare a running remote helper's hash to the local build
# without re-uploading when the remote is already up-to-date.
#
# Algorithm: sha256 each .go file and go.mod (sorted by name for stability),
# then sha256 the concatenated "<filename>:<hash>\n" lines.
compute_source_hash() {
  local tmp
  tmp="$(mktemp)"
  # Sort by filename for a deterministic ordering across filesystems.
  for f in $(ls *.go go.mod | sort); do
    if [ -f "$f" ]; then
      echo "$f:$(sha256_of "$f")" >> "${tmp}"
    fi
  done
  local hash
  hash="$(sha256_of "${tmp}")"
  rm -f "${tmp}"
  echo "${hash}"
}

SOURCE_HASH="$(compute_source_hash)"
echo "source hash: ${SOURCE_HASH}"

entries=()
for target in "${TARGETS[@]}"; do
  os="${target%/*}"
  arch="${target#*/}"
  filename="helper-${VERSION}-${os}-${arch}"
  outpath="${DIST}/${filename}"

  echo "building ${target} -> ${outpath}"
  CGO_ENABLED=0 GOOS="${os}" GOARCH="${arch}" \
    go build -trimpath \
    -ldflags "-s -w -X main.Version=${VERSION} -X main.SourceHash=${SOURCE_HASH}" \
    -o "${outpath}" .

  sum="$(sha256_of "${outpath}")"
  entries+=("{\"os\":\"${os}\",\"arch\":\"${arch}\",\"filename\":\"${filename}\",\"sha256\":\"${sum}\"}")
done

# Join entries with commas.
joined="$(IFS=,; echo "${entries[*]}")"
cat > "${DIST}/manifest.json" <<EOF
{
  "version": "${VERSION}",
  "protocolVersion": ${PROTOCOL_VERSION},
  "sourceHash": "${SOURCE_HASH}",
  "binaries": [${joined}]
}
EOF

echo "wrote ${DIST}/manifest.json"
