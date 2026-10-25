# Source me: helpers to drive Android UI by text via uiautomator.
#   ADB="adb -s emulator-5600"; . test/android/ui.sh; tap_text "Allow"
ui_dump () { $ADB shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; $ADB shell cat /sdcard/ui.xml; }
# tap_text <regex> [timeout s]: taps the center of the first node whose text or content-desc matches
tap_text () {
  local re=$1 t=${2:-10}
  for _ in $(seq 1 "$t"); do
    local b
    b=$(ui_dump | grep -oE '<node [^>]*>' | grep -E "(text|content-desc)=\"($re)\"" | head -1 | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | grep -oE '[0-9]+' | tr '\n' ' ')
    if [ -n "$b" ]; then
      set -- $b
      $ADB shell input tap $(( ($1+$3)/2 )) $(( ($2+$4)/2 ))
      return 0
    fi
    sleep 1
  done
  echo "tap_text: '$re' not found" >&2; return 1
}
has_text () { ui_dump | grep -qE "(text|content-desc)=\"($1)\""; }
