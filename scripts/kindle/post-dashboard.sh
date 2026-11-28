#!/bin/sh

umask 077
BASE=/mnt/us/extensions/WebLaunch
SELF="$BASE/bin/post-dashboard.sh"
LOG="$BASE/weblaunch.log"
SECRET_DIR=/var/local/kindle-dashboard
SECRET_FILE="$SECRET_DIR/device-secret"
SEED="$BASE/.kindle-device-seed"
RUNTIME=/tmp/kindle-dashboard-post
PID_FILE="$RUNTIME/pid"
PAGE=/mnt/us/kindle-dashboard.html
NEXT_PAGE="$BASE/.kindle-dashboard-next.html"
ENDPOINT=https://kindle.mossony.online/device/dashboard

log_msg() {
	printf '%s POST dashboard %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"
}

private_dir() {
	[ ! -L "$1" ] && { [ -d "$1" ] || mkdir "$1"; } && chmod 700 "$1"
}

provision() {
	private_dir "$SECRET_DIR" || return 1
	[ ! -L "$SECRET_FILE" ] || return 1
	if [ ! -f "$SECRET_FILE" ]; then
		[ -f "$SEED" ] || return 1
		tr -d '\r\n' < "$SEED" > "$SECRET_FILE.tmp" || return 1
		if ! grep -Eq '^[0-9A-F]{64}$' "$SECRET_FILE.tmp"; then
			rm -f "$SECRET_FILE.tmp"
			return 1
		fi
		chmod 600 "$SECRET_FILE.tmp" && mv "$SECRET_FILE.tmp" "$SECRET_FILE" || return 1
	fi
	chmod 600 "$SECRET_FILE" && grep -Eq '^[0-9A-F]{64}$' "$SECRET_FILE"
}

running() {
	[ -r "$PID_FILE" ] || return 1
	read PID < "$PID_FILE"
	case "$PID" in ''|*[!0-9]*) return 1 ;; esac
	[ -r "/proc/$PID/cmdline" ] && kill -0 "$PID" 2>/dev/null || return 1
	case "$(tr '\000' ' ' < "/proc/$PID/cmdline" 2>/dev/null)" in
		*"$SELF run "*) return 0 ;;
		*) return 1 ;;
	esac
}

cleanup() {
	rm -f "$PID_FILE" "$NEXT_PAGE"
}

run() {
	unset LD_LIBRARY_PATH
	command -v curl >/dev/null 2>&1 || { log_msg 'curl is not available'; return 1; }
	provision || { log_msg 'cannot provision device credential'; return 1; }
	if [ ! -s "$PAGE" ]; then
		printf '%s\n' '<!doctype html><meta http-equiv="refresh" content="8"><title>Kindle Dashboard</title><h1>Waiting for dashboard</h1><p>Check Wi-Fi if this persists.</p>' > "$PAGE" || return 1
	fi
	trap cleanup EXIT
	trap 'exit 0' HUP INT TERM
	printf '%s\n' "$$" > "$PID_FILE" || return 1
	log_msg 'local HTML updater started'
	while :; do
		status=$(curl -q -s --noproxy '*' --connect-timeout 6 --max-time 15 \
			-A 'KindleDashboard-Device/1.0' --data-urlencode "password@$SECRET_FILE" \
			-o "$NEXT_PAGE" -w '%{http_code}' "$ENDPOINT")
		rc=$?
		if [ "$rc" -eq 0 ] && [ "$status" = 200 ] && grep -q '<title>Kindle Dashboard</title>' "$NEXT_PAGE"; then
			if mv "$NEXT_PAGE" "$PAGE" && [ -f "$SEED" ]; then
				rm -f "$SEED" && log_msg 'credential import verified and USB seed removed'
			fi
		else
			log_msg "fetch failed rc=$rc HTTP=$status"
		fi
		sleep 60 &
		wait "$!"
	done
}

case "$1" in
	start)
		private_dir "$RUNTIME" || exit 1
		if running; then exit 0; fi
		rm -f "$PID_FILE"
		nohup /bin/sh "$SELF" run </dev/null >> "$LOG" 2>&1 &
		sleep 2
		running
		;;
	stop)
		if running; then kill "$PID"; fi
		;;
	run) run ;;
	*) exit 2 ;;
esac
