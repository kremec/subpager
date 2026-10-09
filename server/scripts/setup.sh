#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="$project_dir/bin"
decoder_version="1.6.1"
decoder_path="$install_dir/multimon-ng-$decoder_version"
configure_usb=false
if [[ "${1:-}" == "--configure-usb" ]]; then
  configure_usb=true
  shift
fi
if [[ $# -ne 0 ]]; then
  printf '%s\n' 'Usage: setup.sh [--configure-usb]' >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin)
    if ! command -v brew >/dev/null 2>&1; then
      printf '%s\n' 'Install Homebrew from https://brew.sh, then run this script again.' >&2
      exit 1
    fi
    if ! xcrun --find clang >/dev/null 2>&1; then
      printf '%s\n' 'Install the Apple command line tools with xcode-select --install, then run this script again.' >&2
      exit 1
    fi
    brew install librtlsdr cmake
    ;;
  Linux)
    if ! command -v apt-get >/dev/null 2>&1; then
      printf '%s\n' 'This installer supports Debian/Ubuntu. Install rtl-sdr, a C compiler, cmake and git with your distribution package manager.' >&2
      exit 1
    fi
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends rtl-sdr build-essential cmake git
    if [[ "$configure_usb" == true ]]; then
      usb_group="$(id -gn "${SUDO_USER:-$(id -un)}")"
      usb_rule="$(mktemp "${TMPDIR:-/tmp}/subpager-usb.XXXXXX")"
      printf 'SUBSYSTEM=="usb", ATTR{idVendor}=="0bda", ATTR{idProduct}=="2838", GROUP="%s", MODE="0660"\n' "$usb_group" > "$usb_rule"
      printf 'SUBSYSTEM=="usb", ATTR{idVendor}=="0bda", ATTR{idProduct}=="2832", GROUP="%s", MODE="0660"\n' "$usb_group" >> "$usb_rule"
      sudo install -m 644 "$usb_rule" /etc/udev/rules.d/70-subpager-rtlsdr.rules
      rm -- "$usb_rule"
      sudo udevadm control --reload-rules
      printf '%s\n' 'Receiver USB permissions configured. Unplug and reconnect the NESDR. No kernel driver has been blacklisted.'
    fi
    ;;
  *)
    printf '%s\n' 'Use setup.ps1 on Windows. See README.md.' >&2
    exit 1
    ;;
esac

mkdir -p "$install_dir"
if [[ -x "$decoder_path" ]]; then
  printf 'multimon-ng %s is already installed at %s\n' "$decoder_version" "$decoder_path"
else
  build_dir="$(mktemp -d "${TMPDIR:-/tmp}/subpager-radio.XXXXXX")"
  trap 'rm -rf -- "$build_dir"' EXIT
  git clone --branch "$decoder_version" --depth 1 https://github.com/EliasOenal/multimon-ng.git "$build_dir/source"
  cmake -S "$build_dir/source" -B "$build_dir/build" \
    -DCMAKE_BUILD_TYPE=Release -DX11_SUPPORT=OFF -DPULSE_AUDIO_SUPPORT=OFF -DSDL3_SCOPE=OFF -DBUILD_GEN_NG=OFF
  cmake --build "$build_dir/build" --target multimon-ng --parallel 4
  install -m 755 "$build_dir/build/multimon-ng" "$decoder_path"
fi

printf '\nDecoder installed at %s\n' "$decoder_path"
printf '%s\n' 'Set radio.multimonPath to this path. Run bun run doctor next.'
if [[ "$configure_usb" == false ]]; then
  printf '%s\n' 'No USB permissions, drivers or kernel settings have been changed by this script.'
fi
