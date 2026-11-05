#!/bin/bash
# The release workflow's Node.js (.github/workflows/release.yml, docs/RELEASING.md): every job runs this first, right
# after its checkout. It installs the official build of the version apps/desktop/bundle/node.json pins, for the
# runner's platform (macOS-ARM64: darwin-arm64, Linux-X64: linux-x64):
#  - the tarball node-v<version>-<platform>.tar.gz downloaded from the Node.js project (https only) into
#    $RUNNER_TEMP/node-download, then checked against the sha256 node.json pins for that very file (`tarballs`, from the
#    project's signed SHASUMS256.txt) before anything of it is unpacked or run — so npm, corepack and every other file
#    of the install are the checked ones, not the binary alone;
#  - unpacked into $RUNNER_TEMP/node (a folder of the job's own, emptied first), its bin/node checked against the
#    binary's pin too (`sha256`, the one the stage's checkNode reads), the download removed;
#  - its bin folder put first on PATH for the job's next steps ($GITHUB_PATH).
# It never runs node (a binary cannot vouch for itself). curl, shasum and tar come from PATH (the runner's own; the
# tests' stand-ins). Messages are GitHub annotations (::error::) on stdout.
set -euo pipefail

die() {
  echo "::error::$*"
  exit 1
}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pins="$here/../bundle/node.json"
[ -f "$pins" ] || die "apps/desktop/bundle/node.json is missing"
case "${RUNNER_OS:-}-${RUNNER_ARCH:-}" in
  macOS-ARM64) platform=darwin-arm64 ;;
  Linux-X64) platform=linux-x64 ;;
  *) die "apps/desktop/bundle/node.json pins no Node.js for ${RUNNER_OS:-?}-${RUNNER_ARCH:-?}" ;;
esac
case "${RUNNER_TEMP:-}" in /*) ;; *) die "RUNNER_TEMP must be an absolute path (a GitHub Actions runner's)" ;; esac
case "${GITHUB_PATH:-}" in /*) ;; *) die "GITHUB_PATH must be an absolute path (a GitHub Actions runner's)" ;; esac

# One "<key>": "<value>" line of node.json whose value matches <pattern> (a sed basic regular expression), exactly once.
pin() {
  local key=${1//./\\.} found
  found=$(sed -n "s/^[[:space:]]*\"$key\"[[:space:]]*:[[:space:]]*\"\($2\)\"[[:space:]]*,\{0,1\}[[:space:]]*$/\1/p" "$pins")
  [ -n "$found" ] && [ "$(printf '%s\n' "$found" | wc -l | tr -d ' ')" = 1 ] || return 1
  printf '%s\n' "$found"
}
version=$(pin version '[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*') || die "apps/desktop/bundle/node.json pins no Node.js version"
file="node-v$version-$platform.tar.gz"
want=$(pin "$file" '[0-9a-f]\{64\}') || die "apps/desktop/bundle/node.json pins no sha256 for $file (tarballs)"
binary=$(pin "$platform" '[0-9a-f]\{64\}') || die "apps/desktop/bundle/node.json pins no Node.js binary for $platform (sha256)"

dl="$RUNNER_TEMP/node-download"
dest="$RUNNER_TEMP/node"
rm -rf "$dl" "$dest"
mkdir -p "$dl"
url="https://nodejs.org/dist/v$version/$file"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 \
  --output "$dl/$file" "$url" || die "$url could not be downloaded"
got=$(shasum -a 256 "$dl/$file" | cut -d' ' -f1)
if [ "$got" != "$want" ]; then
  rm -rf "$dl"
  die "$file is not the tarball apps/desktop/bundle/node.json pins (sha256 $got, pinned $want): nothing of it was unpacked — record a checked upgrade there (its about says how)"
fi
mkdir -p "$dest"
tar -xzf "$dl/$file" -C "$dest" || die "$file could not be unpacked"
rm -rf "$dl"
home="$dest/node-v$version-$platform"
node="$home/bin/node"
[ -f "$node" ] && [ ! -L "$node" ] || die "$file holds no bin/node"
got=$(shasum -a 256 "$node" | cut -d' ' -f1)
[ "$got" = "$binary" ] || die "$node is not the Node.js binary apps/desktop/bundle/node.json pins for $platform (sha256 $got, pinned $binary): its tarball and binary pins disagree"
echo "$home/bin" >>"$GITHUB_PATH"
echo "Node.js $version ($platform): $file checked (sha256 $want), its bin/node the pinned binary; $home/bin first on PATH"
