#!/usr/bin/env sh
# Raster siblings for public/favicon.svg. The SVG is the source of truth and is
# what browsers use; the ICO covers legacy tabs and the Apple touch icon covers
# "add to home screen". Needs librsvg (rsvg-convert) and ImageMagick (magick),
# and only wants re-running when the mark itself changes.
set -eu

cd "$(dirname "$0")/.."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for size in 16 32 48; do
  rsvg-convert -w "$size" -h "$size" public/favicon.svg -o "$work/icon-$size.png"
done

magick "$work/icon-16.png" "$work/icon-32.png" "$work/icon-48.png" public/favicon.ico

# iOS applies its own squircle mask, so the touch icon is a full-bleed square.
rsvg-convert -w 180 -h 180 -b '#0a0a0a' public/favicon.svg -o public/apple-touch-icon.png
