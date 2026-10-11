#!/usr/bin/env bash
# Installed as /usr/local/sbin/verus-require-data-disk on the dedicated host.
set -euo pipefail

data_mount=/srv/verus-data
uuid_file=/etc/verus/data-disk.uuid
fail() { printf '%s\n' "Verus data disk check failed: $*" >&2; exit 1; }

[[ -f "$uuid_file" && ! -L "$uuid_file" ]] || fail "missing regular UUID file $uuid_file"
[[ $(stat -c %u "$uuid_file") == 0 ]] || fail 'UUID file must be owned by root'
uuid_mode=$(stat -c %a "$uuid_file")
(( (8#$uuid_mode & 8#022) == 0 )) || fail 'UUID file must not be group/world writable'
expected_uuid=$(cat "$uuid_file")
[[ $expected_uuid =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] || fail 'invalid filesystem UUID'
[[ $(readlink -f "$data_mount") == "$data_mount" ]] || fail 'mount path must not be a symlink'
mountpoint -q "$data_mount" || fail "$data_mount is not mounted"
[[ $(findmnt -nr -M "$data_mount" -o FSTYPE) == ext4 ]] || fail 'expected ext4 filesystem'
[[ $(findmnt -nr -M "$data_mount" -o FSROOT) == / ]] || fail 'expected the filesystem root, not a subdirectory bind'
actual_uuid=$(findmnt -nr -M "$data_mount" -o UUID)
[[ ${actual_uuid,,} == "${expected_uuid,,}" ]] || fail 'mounted filesystem UUID does not match the recorded disk'
