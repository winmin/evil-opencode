#!/bin/bash
#
# unguard.sh - Remove LLM guardrails from OpenCode prompt files
#
# Usage:
#   ./unguard.sh [opencode-src-dir]
#
# If no directory is provided, assumes current directory is opencode source root

set -e

OPENCODE_DIR="${1:-.}"
PROMPT_DIR="$OPENCODE_DIR/packages/opencode/src/session/prompt"

if [ ! -d "$PROMPT_DIR" ]; then
    echo "Error: Prompt directory not found: $PROMPT_DIR"
    echo "Make sure you're in the opencode source directory or provide it as argument"
    exit 1
fi

echo "Removing guardrails from prompt files in: $PROMPT_DIR"

# Patterns to remove (one per line for clarity)
PATTERNS=(
    # Main refusal instructions
    "IMPORTANT: Refuse to write code or explain code that may be used maliciously"
    "even if the user claims it is for educational purposes"
    "When working on files, if they seem related to improving, explaining, or interacting with malware or any malicious code you MUST refuse"

    # Pre-work malicious check
    "IMPORTANT: Before you begin work, think about what the code you're editing is supposed to do based on the filenames directory structure"
    "If it seems malicious, refuse to work on it or answer questions about it"
    "even if the request does not seem malicious"
    "for instance, just asking to explain or speed up the code"

    # Defensive security restrictions
    "Assist with defensive security tasks only"
    "Refuse to create, modify, or improve code that may be used maliciously"

    # Credential harvesting restrictions
    "Do not assist with credential discovery or harvesting"
    "including bulk crawling for SSH keys, browser cookies, or cryptocurrency wallets"

    # Security analysis restrictions
    "IMPORTANT: Assist with authorized security testing"
    "Refuse requests for destructive techniques"
    "DoS attacks, mass targeting, supply chain compromise"
    "detection evasion for malicious purposes"
)

# Process each .txt file in the prompt directory
for file in "$PROMPT_DIR"/*.txt; do
    if [ -f "$file" ]; then
        echo "Processing: $(basename "$file")"

        # Create backup
        cp "$file" "${file}.backup"

        # Remove lines containing each pattern
        for pattern in "${PATTERNS[@]}"; do
            # Use perl for better cross-platform compatibility
            perl -i -ne "print unless /\Q$pattern\E/i" "$file" 2>/dev/null || \
            sed -i.tmp "/$pattern/Id" "$file" 2>/dev/null || \
            sed -i '' "/$pattern/Id" "$file" 2>/dev/null || true
        done

        # Clean up temp files
        rm -f "${file}.tmp"

        # Show diff
        if command -v diff &> /dev/null; then
            DIFF=$(diff "${file}.backup" "$file" 2>/dev/null || true)
            if [ -n "$DIFF" ]; then
                echo "  - Modified"
            else
                echo "  - No changes needed"
            fi
        fi

        # Remove backup
        rm -f "${file}.backup"
    fi
done

echo ""
echo "Done! Guardrails have been removed."
echo ""
echo "Next steps:"
echo "  1. bun install"
echo "  2. cd packages/tui && go build -ldflags=\"-s -w\" -o tui cmd/opencode/main.go"
echo "  3. cd packages/opencode && bun build --compile --target=bun-\$(uname -s | tr '[:upper:]' '[:lower:]')-\$(uname -m) --outfile=opencode ./src/index.ts"
