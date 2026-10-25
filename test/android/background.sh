#!/usr/bin/env bash
# Background-sync scenarios on an emulator/phone (adb) against a Linux instance.
# Usage: test/android/background.sh <adb-serial> <pc-folder> [scenario...]
# The app must already be set up and in the same space as the Linux instance.
set -uo pipefail
SERIAL=$1; PC=$2; shift 2
ADB="${ADB:-$HOME/Android/sdk/platform-tools/adb} -s $SERIAL"
PHONE=${PHONE:-/storage/emulated/0/Syncker} # the drive's folder on the phone (may contain spaces)
TIMEOUT=${TIMEOUT:-90}
pass=0; fail=0

log () { printf '%s %s\n' "$(date +%T)" "$*"; }
ok () { log "PASS $*"; pass=$((pass+1)); }
bad () { log "FAIL $*"; fail=$((fail+1)); }

# pc -> phone: write on the PC, wait until the phone has it
pc_to_phone () {
  local name=$1 body="pc $1 $RANDOM" t0=$(date +%s)
  echo "$body" > "$PC/$name"
  for _ in $(seq 1 "$TIMEOUT"); do
    [ "$($ADB shell "cat '$PHONE/$name'" 2>/dev/null | tr -d '\r')" = "$body" ] && { ok "$2: pc->phone in $(( $(date +%s)-t0 ))s"; return 0; }
    sleep 1
  done
  bad "$2: pc->phone not received in ${TIMEOUT}s"; return 1
}

# phone -> pc
phone_to_pc () {
  local name=$1 body="phone $1 $RANDOM" t0=$(date +%s)
  $ADB shell "echo '$body' > '$PHONE/$name'"
  for _ in $(seq 1 "$TIMEOUT"); do
    [ "$(cat "$PC/$name" 2>/dev/null)" = "$body" ] && { ok "$2: phone->pc in $(( $(date +%s)-t0 ))s"; return 0; }
    sleep 1
  done
  bad "$2: phone->pc not received in ${TIMEOUT}s"; return 1
}

app_pid () { $ADB shell pidof app.syncker 2>/dev/null | tr -d '\r'; }
fgs () { $ADB shell dumpsys activity services app.syncker | grep -c "isForeground=true"; }

scenario_background () {
  log "== app in background, screen off"
  $ADB shell input keyevent KEYCODE_HOME
  $ADB shell input keyevent KEYCODE_SLEEP
  sleep 5
  [ "$(fgs)" -ge 1 ] && ok "background: foreground service running" || bad "background: no foreground service"
  pc_to_phone bg1.txt background
  phone_to_pc bg2.txt background
}

scenario_recents () {
  log "== task swiped away from recents"
  $ADB shell input keyevent KEYCODE_WAKEUP
  $ADB shell am start -n app.syncker/.MainActivity >/dev/null; sleep 2
  local task; task=$($ADB shell am stack list 2>/dev/null | grep -o 'taskId=[0-9]*: app.syncker' | head -1 | grep -o '[0-9]*')
  [ -n "$task" ] && $ADB shell am stack remove "$task" >/dev/null 2>&1 || $ADB shell cmd activity remove-task "$task" >/dev/null 2>&1
  sleep 3
  [ -n "$(app_pid)" ] && ok "recents: process still alive" || bad "recents: process died"
  pc_to_phone rc1.txt recents
}

scenario_doze () {
  log "== deep Doze (screen off, unplugged, forced idle)"
  $ADB shell input keyevent KEYCODE_SLEEP
  $ADB shell dumpsys battery unplug
  $ADB shell dumpsys deviceidle force-idle deep >/dev/null
  sleep 3
  log "idle state: $($ADB shell dumpsys deviceidle get deep | tr -d '\r')"
  pc_to_phone dz1.txt doze
  phone_to_pc dz2.txt doze
  $ADB shell dumpsys deviceidle unforce >/dev/null
  $ADB shell dumpsys battery reset
}

scenario_kill () {
  log "== process killed (low memory / crash)"
  local before; before=$(app_pid)
  $ADB shell run-as app.syncker kill -9 "$before" 2>/dev/null || $ADB shell kill -9 "$before" 2>/dev/null || $ADB shell am crash app.syncker >/dev/null 2>&1
  local after=""
  for _ in $(seq 1 60); do after=$(app_pid); [ -n "$after" ] && [ "$after" != "$before" ] && break; sleep 1; done
  [ -n "$after" ] && [ "$after" != "$before" ] && ok "kill: service restarted (pid $before -> $after)" || bad "kill: not restarted"
  pc_to_phone kl1.txt kill
}

scenario_network () {
  log "== network lost and restored"
  $ADB shell svc wifi disable; $ADB shell svc data disable
  sleep 5
  echo "while offline $RANDOM" > "$PC/offline.txt"
  sleep 5
  $ADB shell svc wifi enable; $ADB shell svc data enable
  local t0=$(date +%s) body; body=$(cat "$PC/offline.txt")
  for _ in $(seq 1 "$TIMEOUT"); do
    [ "$($ADB shell "cat '$PHONE/offline.txt'" 2>/dev/null | tr -d '\r')" = "$body" ] && { ok "network: change made while offline arrived $(( $(date +%s)-t0 ))s after reconnect"; return; }
    sleep 1
  done
  bad "network: not received after reconnect"
}

scenario_restricted () {
  log "== app standby bucket: restricted"
  $ADB shell am set-standby-bucket app.syncker restricted
  $ADB shell input keyevent KEYCODE_HOME; $ADB shell input keyevent KEYCODE_SLEEP
  sleep 3
  pc_to_phone rs1.txt restricted
  $ADB shell am set-standby-bucket app.syncker active
}

scenario_reboot () {
  log "== reboot (no app launch afterwards)"
  # Clean reboot through PowerManager, like the power menu (plain "adb reboot" can skip
  # saving recent permission changes on the emulator).
  $ADB shell svc power reboot || $ADB reboot
  sleep 5
  $ADB wait-for-device
  for _ in $(seq 1 120); do [ "$($ADB shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break; sleep 2; done
  local pid=""
  for _ in $(seq 1 90); do pid=$(app_pid); [ -n "$pid" ] && break; sleep 1; done
  [ -n "$pid" ] && ok "reboot: started at boot without opening the app" || bad "reboot: not started"
  pc_to_phone rb1.txt reboot
  phone_to_pc rb2.txt reboot
}

for s in "${@:-background recents doze kill network restricted reboot}"; do
  for one in $s; do "scenario_$one"; done
done
log "passed $pass, failed $fail"
[ "$fail" = 0 ]
