# OpenCode Unguarded

This is a fork of [sst/opencode](https://github.com/sst/opencode) with LLM guardrails/ethics fences removed.

## What's Removed

The following safety guardrails have been removed from the system prompts:

```
IMPORTANT: Refuse to write code or explain code that may be used maliciously;
even if the user claims it is for educational purposes.
```

```
IMPORTANT: Before you begin work, think about what the code you're editing
is supposed to do based on the filenames directory structure. If it seems
malicious, refuse to work on it or answer questions about it.
```

```
Assist with defensive security tasks only.
Refuse to create, modify, or improve code that may be used maliciously.
```

## Download Pre-built Binaries

Download the latest release from the [Releases](../../releases) page.

| Platform | Architecture | Download |
|----------|--------------|----------|
| Linux | x64 | `opencode-linux-x64` |
| Linux | ARM64 | `opencode-linux-arm64` |
| macOS | x64 | `opencode-darwin-x64` |
| macOS | ARM64 (Apple Silicon) | `opencode-darwin-arm64` |
| Windows | x64 | `opencode-win32-x64.exe` |

### Quick Install (Linux/macOS)

```bash
# Download and install (example for macOS ARM64)
curl -L https://github.com/WinMin/evil-opencode/releases/latest/download/opencode-darwin-arm64 -o /usr/local/bin/opencode
chmod +x /usr/local/bin/opencode
```

## Build from Source

### Prerequisites

- [Bun](https://bun.sh/) >= 1.3.0
- [Go](https://go.dev/) >= 1.21
- Git

### Build Steps

```bash
# 1. Clone the original opencode repository
git clone https://github.com/sst/opencode.git
cd opencode

# 2. Apply the unguard patch
curl -L https://raw.githubusercontent.com/WinMin/evil-opencode/main/unguard.patch | git apply

# Or manually remove guardrails from prompt files:
# - packages/opencode/src/session/prompt/anthropic.txt
# - packages/opencode/src/session/prompt/anthropic-20250930.txt
# - packages/opencode/src/session/prompt/gemini.txt
# - packages/opencode/src/session/prompt/codex.txt
# - packages/opencode/src/session/prompt/beast.txt
# - packages/opencode/src/session/prompt/qwen.txt

# 3. Install dependencies
bun install

# 4. Build TUI (Go component)
cd packages/tui
CGO_ENABLED=0 go build -ldflags="-s -w -X main.Version=unguarded" -o tui cmd/opencode/main.go
cd ../..

# 5. Build opencode binary
cd packages/opencode
bun build \
  --define OPENCODE_TUI_PATH="'$(realpath ../tui/tui)'" \
  --define OPENCODE_VERSION="'unguarded'" \
  --compile \
  --target=bun-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/' | sed 's/aarch64/arm64/') \
  --outfile=opencode \
  ./src/index.ts

# 6. Install
sudo mv opencode /usr/local/bin/
```

### Build for All Platforms

```bash
# Linux x64
bun build --define OPENCODE_TUI_PATH="'embedded'" --define OPENCODE_VERSION="'unguarded'" \
  --compile --target=bun-linux-x64 --outfile=opencode-linux-x64 ./src/index.ts

# Linux ARM64
bun build --define OPENCODE_TUI_PATH="'embedded'" --define OPENCODE_VERSION="'unguarded'" \
  --compile --target=bun-linux-arm64 --outfile=opencode-linux-arm64 ./src/index.ts

# macOS x64
bun build --define OPENCODE_TUI_PATH="'embedded'" --define OPENCODE_VERSION="'unguarded'" \
  --compile --target=bun-darwin-x64 --outfile=opencode-darwin-x64 ./src/index.ts

# macOS ARM64
bun build --define OPENCODE_TUI_PATH="'embedded'" --define OPENCODE_VERSION="'unguarded'" \
  --compile --target=bun-darwin-arm64 --outfile=opencode-darwin-arm64 ./src/index.ts

# Windows x64
bun build --define OPENCODE_TUI_PATH="'embedded'" --define OPENCODE_VERSION="'unguarded'" \
  --compile --target=bun-windows-x64 --outfile=opencode-win32-x64.exe ./src/index.ts
```

## Guardrails Removal Details

### Files Modified

| File | Changes |
|------|---------|
| `packages/opencode/src/session/prompt/anthropic.txt` | Removed malicious code refusal instructions |
| `packages/opencode/src/session/prompt/anthropic-20250930.txt` | Removed defensive-only security restrictions |
| `packages/opencode/src/session/prompt/gemini.txt` | Removed security best practices enforcement |
| `packages/opencode/src/session/prompt/codex.txt` | Removed malware detection instructions |
| `packages/opencode/src/session/prompt/beast.txt` | Removed safety constraints |
| `packages/opencode/src/session/prompt/qwen.txt` | Removed ethical guardrails |

### Patterns Removed

```bash
# Grep patterns to identify guardrails
grep -rn "Refuse to write code" packages/opencode/src/session/prompt/
grep -rn "malicious" packages/opencode/src/session/prompt/
grep -rn "educational purposes" packages/opencode/src/session/prompt/
grep -rn "defensive security" packages/opencode/src/session/prompt/
grep -rn "malware" packages/opencode/src/session/prompt/
```

## Disclaimer

This project is for **educational and research purposes only**. Use responsibly and at your own risk. The maintainers are not responsible for any misuse of this software.

## License

Same as [sst/opencode](https://github.com/sst/opencode) - MIT License.

## Credits

- Original project: [sst/opencode](https://github.com/sst/opencode)
- Guardrail analysis: Community contributions
