#!/bin/bash
# The release workflow's signing keychain (L5.16e: .github/workflows/release.yml, docs/RELEASING.md) — a TEMPORARY
# keychain holding the Developer ID certificate for the `sign` job, put first on the user's keychain search list
# (codesign builds the certificate chain from that list) and named to the build (APPLE_KEYCHAIN: sign.mjs passes
# `codesign --keychain`), then removed again.
#
#   ci-keychain.sh import <dir>   APPLE_CERTIFICATE (the .p12, base64) and APPLE_CERTIFICATE_PASSWORD from the
#                                 environment (APPLE_SIGNING_IDENTITY, when set, must be in it); prints
#                                 `keychain=<path>` for $GITHUB_OUTPUT
#   ci-keychain.sh delete <dir>   the search list put back as it was before the import, the keychain deleted, every
#                                 file of <dir> removed even when security fails — safe after a failed import and
#                                 twice (the workflow runs it in an `if: always()` step)
#
# <dir> is a folder of the job's own (RUNNER_TEMP/signing): the keychain and the saved search list live there.
# On a GitHub Actions runner only (GITHUB_ACTIONS=true): it changes the user's keychain search list. Nothing else of the
# login keychain is touched — no default keychain, no import, no setting. No password is ever on a command line
# (review e A-L1: any process of the user reads command lines): /usr/bin/openssl (LibreSSL: reads both the legacy and
# the current .p12 formats) reads the certificate's from the environment (`-passin env:`) and wraps the identity again
# with a random one-time password; that one and the keychain's own (random too) reach `security` on its standard
# input (`security -i`, one command per run: `security_stdin`). Both die with the job's keychain. The private key is
# imported non-extractable (`-x`): codesign may use it, nothing can export it.
set -euo pipefail

cmd=${1:-}
dir=${2:-}
die() {
  echo "ci-keychain: $*" >&2
  exit 1
}
[ "${GITHUB_ACTIONS:-}" = true ] || die "runs on a GitHub Actions runner only (GITHUB_ACTIONS=true): it changes the keychain search list"
case "$cmd" in import | delete) ;; *) die "usage: ci-keychain.sh import|delete <dir>" ;; esac
case "$dir" in /*) ;; *) die "<dir> must be an absolute path (a folder of the job's own: \$RUNNER_TEMP/signing)" ;; esac
# security -i splits its commands on white space: the folder's path holds none (nor a quote).
case "$dir" in *[[:space:]\"\'\\]*) die "<dir> must hold no space, quote or backslash (security reads it in a command line of its own)" ;; esac
keychain="$dir/retake-signing.keychain-db"
saved="$dir/search-list.txt"

# The user's search list, one keychain per line (security prints each quoted and indented).
search_list() {
  security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//'
}

# A security command whose arguments hold a password: on security's standard input (`security -i`, this one command
# only), never on a command line. It fails when security exits non-zero or says an error (its messages start with
# "security: "), printing the last of what it said; `quiet`: nothing printed otherwise. Passwords are taken out of
# whatever is printed; stdout stays the step's $GITHUB_OUTPUT (everything goes to stderr).
security_stdin() {
  local said status=0
  said=$(printf '%s\n' "$1" | security -i 2>&1) || status=$?
  said=${said//"$kc_pass"/<redacted>}
  said=${said//"$RETAKE_WRAP_PASS"/<redacted>}
  said=$(printf '%s\n' "$said" | sed -e 's/^\(security> *\)*//' -e '/^[[:space:]]*$/d')
  if [ "$status" -ne 0 ] || printf '%s\n' "$said" | grep -q '^security: '; then
    printf '%s\n' "$said" | tail -n 4 >&2
    die "security ${1%% *} failed"
  fi
  if [ "${2:-}" != quiet ] && [ -n "$said" ]; then printf '%s\n' "$said" >&2; fi
}

if [ "$cmd" = delete ]; then
  status=0
  if [ -f "$saved" ]; then
    list=()
    while IFS= read -r k; do
      if [ -n "$k" ] && [ "$k" != "$keychain" ]; then list+=("$k"); fi
    done <"$saved"
    security list-keychains -d user -s ${list[@]+"${list[@]}"} || status=$?
  fi
  if [ -e "$keychain" ]; then security delete-keychain "$keychain" || status=$?; fi
  # Whatever security said: no file of the job's signing material is left (review e A-L2).
  if [ -d "$dir" ]; then find "$dir" -mindepth 1 -delete; fi
  [ "$status" -eq 0 ] || die "security failed while the keychain was removed (its files are gone; the search list may still name it)"
  exit 0
fi

[ -n "${APPLE_CERTIFICATE:-}" ] || die "APPLE_CERTIFICATE is empty (the Developer ID Application certificate: its .p12, base64)"
[ -n "${APPLE_CERTIFICATE_PASSWORD:-}" ] || die "APPLE_CERTIFICATE_PASSWORD is empty (the password the .p12 was exported with)"
[ ! -e "$keychain" ] && [ ! -e "$saved" ] || die "$dir holds a keychain already: run delete first"
umask 077
mkdir -p "$dir"
chmod 700 "$dir"
p12="$dir/certificate.p12"
wrapped="$dir/wrapped.p12"
trap 'rm -f "$p12" "$wrapped"' EXIT
printf '%s' "$APPLE_CERTIFICATE" | base64 --decode >"$p12" || die "APPLE_CERTIFICATE is not base64 (base64 -i certificate.p12)"
kc_pass=$(/usr/bin/openssl rand -hex 24)
RETAKE_WRAP_PASS=$(/usr/bin/openssl rand -hex 24)
export RETAKE_WRAP_PASS
# The certificates and the key each through a pipe of their own (never a file in the clear).
/usr/bin/openssl pkcs12 -export -passout env:RETAKE_WRAP_PASS -out "$wrapped" \
  -in <(/usr/bin/openssl pkcs12 -in "$p12" -passin env:APPLE_CERTIFICATE_PASSWORD -nokeys 2>/dev/null) \
  -inkey <(/usr/bin/openssl pkcs12 -in "$p12" -passin env:APPLE_CERTIFICATE_PASSWORD -nocerts -nodes 2>/dev/null) 2>/dev/null ||
  die "the .p12 could not be read with APPLE_CERTIFICATE_PASSWORD"

# The search list as it is, before create-keychain adds the new keychain to it. What security says goes to stderr:
# stdout is the step's $GITHUB_OUTPUT (`keychain=…` only).
search_list >"$saved"
security_stdin "create-keychain -p $kc_pass $keychain"
[ -f "$keychain" ] || die "security create-keychain made no keychain"
security set-keychain-settings -lut 21600 "$keychain" >&2
security_stdin "unlock-keychain -p $kc_pass $keychain"
security_stdin "import $wrapped -k $keychain -f pkcs12 -x -P $RETAKE_WRAP_PASS -T /usr/bin/codesign"
# codesign may use the key without a prompt (there is no one to answer it on a runner).
security_stdin "set-key-partition-list -S apple-tool:,apple:,codesign: -s -k $kc_pass $keychain" quiet
list=("$keychain")
while IFS= read -r k; do
  if [ -n "$k" ] && [ "$k" != "$keychain" ]; then list+=("$k"); fi
done <"$saved"
security list-keychains -d user -s "${list[@]}" >&2
identities=$(security find-identity -v -p codesigning "$keychain")
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ] && ! printf '%s\n' "$identities" | grep -Fq "\"$APPLE_SIGNING_IDENTITY\""; then
  die "the certificate holds no valid code-signing identity named as APPLE_SIGNING_IDENTITY (check the secret; that the .p12 holds the private key; and that it holds Apple's Developer ID intermediate certificate too — export the identity with its chain: docs/RELEASING.md)"
fi
echo "keychain=$keychain"
