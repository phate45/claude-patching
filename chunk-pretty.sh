#!/bin/bash
# Chunk cli.pretty.js into smaller files for ast-grep processing
# Usage: ./chunk-pretty.sh [lines_per_chunk]

LINES_PER_CHUNK=${1:-100000}  # Default 100K lines (well under 200K limit)
INPUT="cli.pretty.js"
OUTPUT_DIR="cli.chunks"

if [[ ! -f "$INPUT" ]]; then
    echo "Error: $INPUT not found"
    echo "Run: js-beautify -f cli.js.original -o cli.pretty.js"
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
