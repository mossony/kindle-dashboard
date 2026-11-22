#!/bin/sh

umask 077
BASE=/mnt/us/extensions/WebLaunch
SELF="$BASE/bin/post-dashboard.sh"
LOG="$BASE/weblaunch.log"
SECRET_DIR=/var/local/kindle-dashboard
SECRET_FILE="$SECRET_DIR/device-secret"
SEED="$BASE/.kindle-device-seed"
RUNTIME=/tmp/kindle-dashboard-post
WEB="$RUNTIME/www"
PID_FILE="$RUNTIME/pid"
PORT=8765
ENDPOINT=https://kindle.mossony.online/device/dashboard
HTTP_PID=""

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
	if [ -n "$HTTP_PID" ]; then
		kill "$HTTP_PID" 2>/dev/null
		wait "$HTTP_PID" 2>/dev/null
	fi
	rm -f "$PID_FILE" "$RUNTIME/next.html"
}

run() {
	unset LD_LIBRARY_PATH
	command -v curl >/dev/null 2>&1 || { log_msg 'curl is not available'; return 1; }
	command -v busybox >/dev/null 2>&1 || { log_msg 'BusyBox is not available'; return 1; }
	provision || { log_msg 'cannot provision device credential'; return 1; }
	private_dir "$WEB" || return 1
	if [ ! -s "$WEB/index.html" ]; then
		printf '%s\n' '<!doctype html><meta http-equiv="refresh" content="8"><title>Kindle Dashboard</title><h1>Waiting for dashboard</h1><p>Check Wi-Fi if this persists.</p>' > "$WEB/index.html" || return 1
	fi
	trap cleanup EXIT
	trap 'exit 0' HUP INT TERM
	busybox httpd -f -p "127.0.0.1:$PORT" -h "$WEB" >> "$LOG" 2>&1 &
	HTTP_PID=$!
	sleep 1
	kill -0 "$HTTP_PID" 2>/dev/null || { log_msg 'loopback HTTP server failed'; return 1; }
	printf '%s\n' "$$" > "$PID_FILE" || return 1
	log_msg "loopback server ready on 127.0.0.1:$PORT"
	while kill -0 "$HTTP_PID" 2>/dev/null; do
		status=$(curl -q -s --noproxy '*' --connect-timeout 6 --max-time 15 \
			-A 'KindleDashboard-Device/1.0' --data-urlencode "password@$SECRET_FILE" \
			-o "$RUNTIME/next.html" -w '%{http_code}' "$ENDPOINT")
		rc=$?
		if [ "$rc" -eq 0 ] && [ "$status" = 200 ] && grep -q '<title>Kindle Dashboard</title>' "$RUNTIME/next.html"; then
			if mv "$RUNTIME/next.html" "$WEB/index.html" && [ -f "$SEED" ]; then
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
