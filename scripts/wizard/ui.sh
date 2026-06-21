#!/usr/bin/env bash
# Rendering helpers for the setup wizard: gum when present (styled boxes/inputs/spinners),
# plain ANSI + read fallback otherwise. Honors NO_COLOR + non-TTY. Sourced, not run.

HAS_GUM=0
command -v gum >/dev/null 2>&1 && HAS_GUM=1

_color() { # _color <sgr> <text>
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then printf '\033[%sm%s\033[0m' "$1" "$2"; else printf '%s' "$2"; fi
}

ui_title() {
  if [ "$HAS_GUM" = 1 ]; then gum style --border rounded --padding "0 2" --foreground 212 "$1"
  else printf '\n'; _color "1;36" "==== $1 ===="; printf '\n'; fi
}

ui_say()  { printf '  %s\n' "$1"; }
ui_ok()   { printf '  '; _color "1;32" "✓"; printf ' %s\n' "$1"; }
ui_warn() { printf '  '; _color "1;33" "!"; printf ' %s\n' "$1"; }
ui_err()  { printf '  '; _color "1;31" "✗"; printf ' %s\n' "$1" >&2; }

ui_input() { # ui_input <prompt> [default]  -> value on stdout
  local prompt="$1" def="${2:-}"
  if [ "$HAS_GUM" = 1 ]; then gum input --prompt "$prompt " --value "$def"
  else local v; read -r -p "$prompt [${def}]: " v; printf '%s' "${v:-$def}"; fi
}

ui_password() { # ui_password <prompt>  -> secret on stdout (never echoed)
  local prompt="$1"
  if [ "$HAS_GUM" = 1 ]; then gum input --password --prompt "$prompt "
  else local v; read -rs -p "$prompt: " v; printf '\n' >&2; printf '%s' "$v"; fi
}

ui_confirm() { # ui_confirm <prompt>  -> exit 0 if yes
  local prompt="$1"
  if [ "$HAS_GUM" = 1 ]; then gum confirm "$prompt"
  else local v; read -r -p "$prompt [y/N]: " v; [ "$v" = y ] || [ "$v" = Y ]; fi
}

ui_choose() { # ui_choose <header> <opt>...  -> chosen on stdout
  local header="$1"; shift
  if [ "$HAS_GUM" = 1 ]; then gum choose --header "$header" "$@"
  else printf '  %s\n' "$header" >&2; local x; select x in "$@"; do [ -n "$x" ] && { printf '%s' "$x"; break; }; done; fi
}

ui_spin() { # ui_spin <title> <cmd...>
  local title="$1"; shift
  if [ "$HAS_GUM" = 1 ]; then gum spin --spinner dot --title "$title" -- "$@"
  else printf '  … %s\n' "$title"; "$@"; fi
}
