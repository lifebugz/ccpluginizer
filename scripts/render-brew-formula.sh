#!/usr/bin/env bash
set -euo pipefail

# Single source of truth for the Homebrew formula text. Used by:
#   - the one-time tap bootstrap (local), and
#   - the publish-formula CI job in release-binaries.yml.
# Per-release, CI substitutes only the version + 3 sha256 digests — never new Ruby —
# so `brew style`/`audit` lock this template's style once and `ruby -c` is the
# ongoing regression guard.
#
# Usage: render-brew-formula.sh <version> <sha_darwin_arm64> <sha_linux_x64> <sha_linux_arm64>
VERSION="$1"; SHA_DARWIN_ARM64="$2"; SHA_LINUX_X64="$3"; SHA_LINUX_ARM64="$4"

cat <<RUBY
class Ccpz < Formula
  desc "Pluginize non-plugin Claude Code repos"
  homepage "https://github.com/lifebugz/ccpluginizer"
  # Required: the download URL embeds the version as a mid-path token
  # (ccpz%40${VERSION}) with no parseable archive name at the tail, so brew cannot
  # auto-scan it. Do not remove as redundant.
  version "${VERSION}"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/lifebugz/ccpluginizer/releases/download/%40ccpluginizer/ccpz%40#{version}/ccpz-darwin-arm64", using: :nounzip
      sha256 "${SHA_DARWIN_ARM64}"
    end
    # arm64-only tap: no Intel-macOS branch on purpose. On an Intel Mac brew install
    # fails with "Error: ccpz: formula requires at least a URL" (documented in README).
  end

  on_linux do
    on_intel do
      url "https://github.com/lifebugz/ccpluginizer/releases/download/%40ccpluginizer/ccpz%40#{version}/ccpz-linux-x64", using: :nounzip
      sha256 "${SHA_LINUX_X64}"
    end
    on_arm do
      url "https://github.com/lifebugz/ccpluginizer/releases/download/%40ccpluginizer/ccpz%40#{version}/ccpz-linux-arm64", using: :nounzip
      sha256 "${SHA_LINUX_ARM64}"
    end
  end

  def install
    # :nounzip stages exactly one file. Glob "*" instead of a name pattern so install
    # never depends on the staged filename. Parenthesized odie keeps Style/AndOr happy.
    binary = Dir["*"].find { |f| File.file?(f) } || odie("ccpz: no downloaded binary staged")
    bin.install binary => "ccpz"
  end

  test do
    # ccpz has no --version/--help. Exercise a real subcommand with a known nonzero
    # exit (1) and stable error text.
    (testpath/"bad.json").write("not json")
    output = shell_output("#{bin}/ccpz validate #{testpath}/bad.json 2>&1", 1)
    assert_match("Invalid JSON", output)
  end
end
RUBY
