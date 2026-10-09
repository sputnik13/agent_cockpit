#!/usr/bin/env bash
# Build the exact libghostty-vt revision used by the M1A shadow tests.
#
# This script intentionally never removes or rewrites an existing checkout or
# install prefix. A partially created checkout/prefix is reported for manual
# inspection instead of being cleaned up automatically.
set -euo pipefail

readonly ghostty_repository="https://github.com/ghostty-org/ghostty.git"
readonly ghostty_revision="f2d5758f6305867dc36b36293c6165d8152b853e"

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="${COCKPIT_MUX_BUILD_DIR:-${root_dir}/.build}/libghostty-vt"
target="${LIBGHOSTTY_TARGET:-native}"
prefix="${LIBGHOSTTY_PREFIX:-${build_dir}/${target}}"
source_dir="${build_dir}/source-${ghostty_revision}"
pkgconfig_file="${prefix}/share/pkgconfig/libghostty-vt-static.pc"
provision_stamp="${prefix}/.cockpit-mux-libghostty-vt-provision"

if ! command -v git >/dev/null 2>&1; then
  echo "libghostty-vt provisioning requires git" >&2
  exit 1
fi
if ! command -v zig >/dev/null 2>&1; then
  echo "libghostty-vt provisioning requires Zig 0.16 or newer" >&2
  exit 1
fi

if [[ -e "${source_dir}" ]]; then
  if [[ ! -d "${source_dir}/.git" ]]; then
    echo "refusing to use non-git libghostty-vt source path: ${source_dir}" >&2
    exit 1
  fi
  actual_repository="$(git -C "${source_dir}" config --get remote.origin.url || true)"
  if [[ "${actual_repository}" != "${ghostty_repository}" ]]; then
    echo "refusing source repository ${actual_repository}; expected ${ghostty_repository}" >&2
    exit 1
  fi
  if git -C "${source_dir}" rev-parse --verify HEAD >/dev/null 2>&1; then
    actual_revision="$(git -C "${source_dir}" rev-parse HEAD)"
    if [[ "${actual_revision}" != "${ghostty_revision}" ]]; then
      echo "refusing source revision ${actual_revision}; expected ${ghostty_revision}" >&2
      exit 1
    fi
  else
    # A failed initial clone has no checked-out revision. Complete that same
    # checkout in place; do not remove or replace any existing path.
    git -C "${source_dir}" fetch --filter=blob:none origin "${ghostty_revision}"
    git -C "${source_dir}" checkout --detach "${ghostty_revision}"
  fi
  if ! git -C "${source_dir}" diff --quiet || ! git -C "${source_dir}" diff --cached --quiet; then
    echo "refusing modified libghostty-vt source checkout: ${source_dir}" >&2
    exit 1
  fi
else
  mkdir -p "${build_dir}"
  git clone --filter=blob:none --no-checkout "${ghostty_repository}" "${source_dir}"
  git -C "${source_dir}" checkout --detach "${ghostty_revision}"
fi

build_args=(-Demit-lib-vt -Demit-xcframework=false -Demit-macos-app=false --prefix "${prefix}")
identity_args="-Demit-lib-vt -Demit-xcframework=false -Demit-macos-app=false"
if [[ "${target}" != "native" ]]; then
  build_args+=("-Dtarget=${target}")
  identity_args+=" -Dtarget=${target}"
fi
provision_identity="revision=${ghostty_revision};target=${target};zig_args=${identity_args}"

if [[ -f "${pkgconfig_file}" ]]; then
  if [[ -f "${provision_stamp}" ]]; then
    if ! diff -u <(printf '%s\n' "${provision_identity}") "${provision_stamp}" >/dev/null; then
      echo "refusing libghostty-vt prefix with a different revision/build identity: ${prefix}" >&2
      exit 1
    fi
  else
    # Prefixes made before provenance stamps are admitted once only after the
    # exact, clean source checkout above has been verified. Every later reuse
    # must match this explicit revision/target/build-argument identity.
    printf '%s\n' "${provision_identity}" > "${provision_stamp}"
    echo "recorded verified libghostty-vt provenance: ${prefix}"
  fi
  echo "libghostty-vt already provisioned: ${prefix}"
  exit 0
fi
if [[ -e "${prefix}" ]]; then
  echo "refusing to modify incomplete libghostty-vt prefix: ${prefix}" >&2
  echo "inspect or remove that path manually before retrying" >&2
  exit 1
fi

(
  cd "${source_dir}"
  zig build "${build_args[@]}"
)

if [[ ! -f "${pkgconfig_file}" ]]; then
  echo "libghostty-vt build did not create ${pkgconfig_file}" >&2
  exit 1
fi
printf '%s\n' "${provision_identity}" > "${provision_stamp}"

echo "libghostty-vt provisioned: ${prefix}"
