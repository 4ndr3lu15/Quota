#!/bin/sh
# Add Quota (the GTK app and the GNOME Shell top-bar extension) to your session,
# running straight from this source tree.
set -eu
# On NixOS the stable Quota is a Nix package (Dotfiles, nixos/monolito.nix): installing
# means promoting this source there, and a launcher here would shadow it.
if command -v monolito-promote >/dev/null 2>&1; then
    echo "Quota is installed by Nix. Promote this source with: monolito-promote Quota" >&2
    exit 1
fi

APP_ID=io.github._4ndr3lu15.Quota
UUID=quota@4ndr3lu15.github.io
HERE=$(cd "$(dirname "$0")" && pwd)
DATA=${XDG_DATA_HOME:-$HOME/.local/share}
BIN=$HOME/.local/bin
DESKTOP=$DATA/applications/$APP_ID.desktop
ICONS=$DATA/icons/hicolor
EXT=$DATA/gnome-shell/extensions/$UUID

chmod +x "$HERE/quota-app" "$HERE/tools/compile-schemas.sh"
"$HERE/tools/compile-schemas.sh"

mkdir -p "$BIN" "$DATA/applications" "$ICONS/scalable/apps" "$ICONS/symbolic/apps" "$(dirname "$EXT")"
ln -sfn "$HERE/quota-app" "$BIN/quota"
cp "$HERE/data/icons/hicolor/scalable/apps/$APP_ID.svg" "$ICONS/scalable/apps/"
cp "$HERE/data/icons/hicolor/symbolic/apps/$APP_ID-symbolic.svg" "$ICONS/symbolic/apps/"
sed "s|^Exec=quota|Exec=$BIN/quota|" "$HERE/data/$APP_ID.desktop" > "$DESKTOP"

gtk4-update-icon-cache -q -t -f "$ICONS" 2>/dev/null || gtk-update-icon-cache -q -t -f "$ICONS" 2>/dev/null || true
update-desktop-database -q "$DATA/applications" 2>/dev/null || true

# Symlink the extension straight to src/ so changes take effect without re-packing
[ -L "$EXT" ] || rm -rf "$EXT"
ln -sfn "$HERE/src" "$EXT"
gnome-extensions enable "$UUID" 2>/dev/null || true

echo "Installed Quota. App runs from $HERE; extension linked at $EXT."
