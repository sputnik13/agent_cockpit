#!/usr/bin/env bash
# devenv-cap-spike.sh — validate per-project systemd-scope memory caps for agent_cockpit.
#
# Purpose: confirm a project's tmux server (and therefore all dev work in its
# panes) can be bounded by a MemoryMax cgroup so a runaway OOMs in-scope instead
# of crashing the shared host. Tied to docs/proposals/dev-env-modes-resource-caps.md.
#
# RUN IT THE FAITHFUL WAY (mirrors the app's non-interactive SSH exec context):
#     ssh <user>@<host> 'bash -s' < docs/spikes/devenv-cap-spike.sh
# Also run it interactively on the box (ssh in, then `bash devenv-cap-spike.sh`)
# and compare — passing interactively but failing over the one-liner is the
# lingering / user-bus gotcha (fix printed in the verdict).
#
# Safe: throwaway tmux socket + scope, tiny cap, cleans up, no sudo.

SOCK=spikecap
UNIT="spikecap-$$"
CAP=128M                 # tiny cap so the OOM probe cannot hurt the host
CAP_BYTES=134217728      # 128 * 1024 * 1024

pass(){ echo "PASS  $*"; }
fail(){ echo "FAIL  $*"; }
info(){ echo "----  $*"; }

echo "==================== agent_cockpit dev-env cap spike ===================="
info "user=$(id -un) uid=$(id -u)  host=$(hostname)"
info "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-<unset>}"
info "DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-<unset>}"

# 1) cgroup v2 (unified) — MemoryMax semantics assume this.
if [ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)" = cgroup2fs ]; then
  pass "cgroup v2 (unified) present"
else
  fail "cgroup v2 NOT present (hybrid/v1) — report this; MemoryMax semantics differ"
fi

# 2) systemd + user-manager reachability IN THIS CONTEXT (the #1 non-interactive risk).
info "systemd: $(systemctl --version 2>/dev/null | head -1 || echo none)"
info "linger:  $(loginctl show-user "$(id -u)" -p Linger 2>/dev/null || echo unknown)"
if systemctl --user is-system-running >/dev/null 2>&1 || systemctl --user show -p Version >/dev/null 2>&1; then
  pass "systemd --user bus reachable in this exec context"
  USERBUS=1
else
  fail "systemd --user bus NOT reachable here (likely no lingering / no XDG_RUNTIME_DIR)"
  USERBUS=0
fi

# 3) A --user scope actually applies a MemoryMax.
if [ "$USERBUS" = 1 ]; then
  OUT=$(systemd-run --user --scope -q -p MemoryMax=$CAP -p MemorySwapMax=0 \
        bash -c 'cg=$(awk -F: "{print \$3}" /proc/self/cgroup); echo "$cg|$(cat /sys/fs/cgroup$cg/memory.max 2>/dev/null)"' 2>&1)
  echo "      scope ctx: $OUT"
  if echo "$OUT" | grep -q "|$CAP_BYTES"; then
    pass "MemoryMax=$CAP applied to a --user scope"
  else
    fail "could not confirm MemoryMax in a --user scope (see line above)"
  fi
else
  info "skipping scope tests (no user bus). A SYSTEM scope alternative needs a privileged path:"
  info "    sudo systemd-run --scope -p MemoryMax=$CAP -p MemorySwapMax=0 tmux -L $SOCK start-server ..."
fi

# 4) KEY TEST: does the daemonized tmux server STAY in the capped scope?
SERVER_OK=0
if [ "$USERBUS" = 1 ]; then
  tmux -L $SOCK kill-server 2>/dev/null
  systemd-run --user --scope -q --unit="$UNIT" \
    -p MemoryMax=$CAP -p MemorySwapMax=0 -p TasksMax=256 \
    tmux -L $SOCK new-session -d -s probe \; set -g exit-empty off \; set -g history-limit 5000 2>&1
  sleep 0.5
  SRV=$(tmux -L $SOCK display -p -t probe '#{pid}' 2>/dev/null)
  if [ -n "$SRV" ] && [ -r "/proc/$SRV/cgroup" ]; then
    SCG=$(awk -F: '{print $3}' "/proc/$SRV/cgroup" 2>/dev/null)
    SMAX=$(cat "/sys/fs/cgroup$SCG/memory.max" 2>/dev/null)
    echo "      server pid=$SRV cgroup=$SCG memory.max=$SMAX"
    if echo "$SCG" | grep -q "$UNIT" && [ "$SMAX" = "$CAP_BYTES" ]; then
      pass "tmux SERVER stayed in the capped scope (cap holds for every pane)"
      SERVER_OK=1
    else
      fail "tmux server ESCAPED the scope (cap would NOT hold) — OQ-1 pivot needed; report the cgroup line above"
    fi
  else
    fail "tmux server pid not found after start (report any error above)"
  fi
fi

# 5) DECISIVE: trigger an in-scope OOM and confirm the HOST survives.
if [ "$SERVER_OK" = 1 ]; then
  # 300 MB alloc against a 128 MB cap -> cgroup OOM-kills it mid-allocation.
  tmux -L $SOCK send-keys -t probe 'python3 -c "bytearray(300*1024*1024)"' Enter 2>/dev/null
  sleep 4
  EV=$(cat "/sys/fs/cgroup$SCG/memory.events" 2>/dev/null | tr '\n' ' ')
  echo "      memory.events: ${EV:-<none>}"
  OOMN=$(echo "$EV" | sed -n 's/.*oom_kill \([0-9]*\).*/\1/p')
  if [ -n "$OOMN" ] && [ "$OOMN" -ge 1 ] 2>/dev/null; then
    pass "in-scope OOM kill fired (the runaway died inside the cap; host stayed up)"
  else
    info "no oom_kill recorded — is python3 installed? otherwise the cap may not be enforced; report memory.events"
  fi
fi

# cleanup
tmux -L $SOCK kill-server 2>/dev/null
[ "$USERBUS" = 1 ] && systemctl --user stop "$UNIT.scope" 2>/dev/null

echo "==================== verdict ===================="
echo "All PASS over the SSH one-liner  -> ship systemd-scope as designed (--user)."
echo "Checks 2-5 fail over SSH but pass interactively -> enable a user session, then re-run:"
echo "    sudo loginctl enable-linger $(id -un)"
echo "  (and the app must export XDG_RUNTIME_DIR=/run/user/$(id -u) in its SSH exec env)"
echo "tmux server ESCAPES the scope (check 4 FAIL) -> opener pivot (OQ-1); send me the cgroup line."
echo "No user bus possible at all -> fall back to a SYSTEM scope via a privileged path."
echo "Send the full output back to finalize the systemd-scope design."
