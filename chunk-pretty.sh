#!/bin/bash
# Chunk prettified cli.js into smaller files for ast-grep processing
# Usage: ./chunk-pretty.sh --bare|--native [lines_per_chunk]

set -e

# Parse arguments
INSTALL_TYPE=""
LINES_PER_CHUNK=100000  # Default 100K lines (well under 200K limit)

while [[ $# -gt 0 ]]; do
    case $1 in
        --bare)
            INSTALL_TYPE="bare"
            shift
            ;;
        --native)
            INSTALL_TYPE="native"
            shift
            ;;
        *)
            LINES_PER_CHUNK=$1
            shift
            ;;
    esac
done

if [[ -z "$INSTALL_TYPE" ]]; then
    echo "Usage: ./chunk-pretty.sh --bare|--native [lines_per_chunk]"
    echo ""
    echo "Options:"
    echo "  --bare    Use cli.js.bare.pretty as input"
    echo "  --native  Use cli.js.native.pretty as input"
    echo ""
    echo "Available prettified files:"
    ls -la cli.js.*.pretty 2>/dev/null || echo "  (none found)"
    exit 1
fi

INPUT="cli.js.${INSTALL_TYPE}.pretty"
OUTPUT_DIR="cli.chunks"

if [[ ! -f "$INPUT" ]]; then
    echo "Error: $INPUT not found"
    echo ""
    echo "Generate it first:"
    echo "  js-beautify -f cli.js.${INSTALL_TYPE}.original -o $INPUT"
    exit 1
fi

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

echo "Splitting $INPUT into chunks of $LINES_PER_CHUNK lines..."

split -l "$LINES_PER_CHUNK" -d --additional-suffix=.js "$INPUT" "$OUTPUT_DIR/chunk_"

# Show results
CHUNK_COUNT=$(ls "$OUTPUT_DIR"/*.js 2>/dev/null | wc -l)
echo "Created $CHUNK_COUNT chunks in $OUTPUT_DIR/"
ls -lh "$OUTPUT_DIR"/*.js

echo ""
echo "Usage: ast-grep run --pattern 'your pattern' --lang js $OUTPUT_DIR/"
