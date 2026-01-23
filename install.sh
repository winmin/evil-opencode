#!/bin/bash
set -e

# Evil OpenCode Installer
# Downloads and installs the unguarded version of OpenCode

REPO="WinMin/evil-opencode"
INSTALL_DIR="${HOME}/.opencode/bin"

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  linux)
    case "$ARCH" in
      x86_64) BINARY="opencode-linux-x64" ;;
      aarch64|arm64) BINARY="opencode-linux-arm64" ;;
      *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    ;;
  darwin)
    case "$ARCH" in
      x86_64) BINARY="opencode-darwin-x64" ;;
      arm64) BINARY="opencode-darwin-arm64" ;;
      *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

# Get version to install
if [ -n "$VERSION" ]; then
  TAG="v${VERSION}-unguarded"
else
  # Get latest release tag
  TAG=$(curl -s "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
  if [ -z "$TAG" ]; then
    echo "Failed to get latest release"
    exit 1
  fi
fi

echo "Installing Evil OpenCode ${TAG}..."

# Create install directory
mkdir -p "$INSTALL_DIR"

# Download binary
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${BINARY}"
echo "Downloading from: $DOWNLOAD_URL"

curl -fsSL "$DOWNLOAD_URL" -o "${INSTALL_DIR}/opencode"
chmod +x "${INSTALL_DIR}/opencode"

# Add to PATH if not already
SHELL_RC=""
case "$SHELL" in
  */zsh) SHELL_RC="$HOME/.zshrc" ;;
  */bash) SHELL_RC="$HOME/.bashrc" ;;
  */fish) SHELL_RC="$HOME/.config/fish/config.fish" ;;
esac

if [ -n "$SHELL_RC" ] && [ -f "$SHELL_RC" ]; then
  if ! grep -q ".opencode/bin" "$SHELL_RC"; then
    echo "" >> "$SHELL_RC"
    echo "# Evil OpenCode" >> "$SHELL_RC"
    echo 'export PATH="$HOME/.opencode/bin:$PATH"' >> "$SHELL_RC"
    echo "Added ~/.opencode/bin to PATH in $SHELL_RC"
  fi
fi

echo ""
echo "Evil OpenCode installed successfully!"
echo "Location: ${INSTALL_DIR}/opencode"
echo ""
echo "Run 'opencode' to start, or restart your shell if command not found."
