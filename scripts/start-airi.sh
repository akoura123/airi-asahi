#!/usr/bin/env bash

# Author: hutianyu
# Starts, stops, and restarts the AIRI server and Electron development app.

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="${TMPDIR:-/tmp}"
STATE_DIR="${AIRI_DEV_STATE_DIR:-${TEMP_DIR%/}/airi-asahi-dev}"
LOG_DIR="$STATE_DIR/logs"
SERVER_PID_FILE="$STATE_DIR/server.pid"
ELECTRON_PID_FILE="$STATE_DIR/electron.pid"
SERVER_LOG="$LOG_DIR/server.log"
ELECTRON_LOG="$LOG_DIR/electron.log"
OPERATION_LOCK_DIR="$STATE_DIR/operation.lock"
OPERATION_LOCK_PID_FILE="$OPERATION_LOCK_DIR/pid"
SERVER_PORT=3000
ELECTRON_PORT=5173
ELECTRON_DEBUG_PORT=9250

mkdir -p "$LOG_DIR"

log() {
  printf '[airi] %s\n' "$*"
}

warn() {
  printf '[airi] warning: %s\n' "$*" >&2
}

is_running() {
  local pid="$1"

  kill -0 "$pid" 2>/dev/null
}

release_operation_lock() {
  local owner_pid=''

  if [[ -f "$OPERATION_LOCK_PID_FILE" ]]; then
    owner_pid="$(<"$OPERATION_LOCK_PID_FILE")"
  fi
  [[ "$owner_pid" == "$$" ]] || return 0

  rm -f "$OPERATION_LOCK_PID_FILE"
  rmdir "$OPERATION_LOCK_DIR" 2>/dev/null || true
}

acquire_operation_lock() {
  local owner_pid=''

  if ! mkdir "$OPERATION_LOCK_DIR" 2>/dev/null; then
    if [[ -f "$OPERATION_LOCK_PID_FILE" ]]; then
      owner_pid="$(<"$OPERATION_LOCK_PID_FILE")"
    fi

    if [[ "$owner_pid" =~ ^[0-9]+$ ]] && is_running "$owner_pid"; then
      warn "另一个 AIRI 启停操作仍在执行（PID ${owner_pid}）"
      return 1
    fi

    # A hard-killed launcher cannot run its EXIT trap. Only remove an empty,
    # stale lock owned by a process that no longer exists.
    rm -f "$OPERATION_LOCK_PID_FILE"
    if ! rmdir "$OPERATION_LOCK_DIR" 2>/dev/null || ! mkdir "$OPERATION_LOCK_DIR" 2>/dev/null; then
      warn '无法取得 AIRI 启停锁，请稍后重试'
      return 1
    fi
  fi

  printf '%s\n' "$$" >"$OPERATION_LOCK_PID_FILE"
  trap release_operation_lock EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

port_pids() {
  local port="$1"

  lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

process_cwd() {
  local pid="$1"

  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

process_command() {
  local pid="$1"

  ps -p "$pid" -o command= 2>/dev/null || true
}

is_airi_process() {
  local pid="$1"
  local kind="$2"
  local cwd
  local command

  cwd="$(process_cwd "$pid")"
  command="$(process_command "$pid")"

  case "$kind" in
    server)
      case "$cwd" in
        "$ROOT_DIR/apps/server"|"$ROOT_DIR/apps/server/"*) ;;
        *) return 1 ;;
      esac
      case "$command" in
        *"src/bin/run.ts api"*|*"pnpm start"*|*"@proj-airi/server"*) return 0 ;;
      esac
      ;;
    electron)
      case "$cwd" in
        "$ROOT_DIR"|"$ROOT_DIR/apps/stage-tamagotchi"|"$ROOT_DIR/apps/stage-tamagotchi/"*) ;;
        *) return 1 ;;
      esac
      case "$command" in
        *"@proj-airi/stage-tamagotchi"*|*"electron-vite"*|*"stage-tamagotchi"*|*"vite"*|*"Electron.app/Contents/MacOS/Electron ."*) return 0 ;;
      esac
      ;;
    *) return 1 ;;
  esac

  return 1
}

has_owned_port() {
  local port="$1"
  local kind="$2"
  local pid

  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if is_airi_process "$pid" "$kind"; then
      return 0
    fi
  done < <(port_pids "$port")

  return 1
}

kill_process_tree() {
  local pid="$1"
  local child

  while IFS= read -r child; do
    [[ -n "$child" ]] || continue
    kill_process_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)

  kill -TERM "$pid" 2>/dev/null || true
}

wait_until_stopped() {
  local pid="$1"
  local attempt

  for ((attempt = 0; attempt < 40; attempt++)); do
    is_running "$pid" || return 0
    sleep 0.25
  done

  if is_running "$pid"; then
    warn "进程 $pid 未在 10 秒内退出，发送强制终止信号"
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

stop_pid() {
  local pid="$1"
  local kind="$2"

  if ! [[ "$pid" =~ ^[0-9]+$ ]] || ! is_running "$pid"; then
    return 0
  fi

  if ! is_airi_process "$pid" "$kind"; then
    warn "跳过 PID ${pid}：不是当前仓库的 AIRI $kind 进程"
    return 0
  fi

  log "停止 AIRI $kind 进程（PID ${pid}）"
  kill_process_tree "$pid"
  wait_until_stopped "$pid"
}

stop_pid_file() {
  local file="$1"
  local kind="$2"
  local pid=''

  if [[ -f "$file" ]]; then
    pid="$(<"$file")"
    stop_pid "$pid" "$kind"
    rm -f "$file"
  fi
}

stop_port_processes() {
  local port="$1"
  local kind="$2"
  local pid

  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    stop_pid "$pid" "$kind"
  done < <(port_pids "$port")
}

stop_all() {
  stop_pid_file "$ELECTRON_PID_FILE" electron
  stop_pid_file "$SERVER_PID_FILE" server

  # Also find processes started before this script created its PID files.
  stop_port_processes "$ELECTRON_PORT" electron
  stop_port_processes "$ELECTRON_DEBUG_PORT" electron
  stop_port_processes "$SERVER_PORT" server

  log 'AIRI 服务已停止'
}

wait_for_port() {
  local port="$1"
  local attempt

  for ((attempt = 0; attempt < 60; attempt++)); do
    if [[ -n "$(port_pids "$port")" ]]; then
      return 0
    fi
    sleep 0.5
  done

  return 1
}

start_server() {
  if [[ -n "$(port_pids "$SERVER_PORT")" ]]; then
    if has_owned_port "$SERVER_PORT" server; then
      log "服务端口 $SERVER_PORT 已由 AIRI 占用，跳过启动"
      return 0
    fi
    warn "服务端口 $SERVER_PORT 已被其他进程占用，请先处理该进程"
    return 1
  fi

  log "启动 AIRI 服务端，日志：$SERVER_LOG"
  (
    cd "$ROOT_DIR/apps/server"
    exec nohup pnpm start
  ) >>"$SERVER_LOG" 2>&1 < /dev/null &
  echo "$!" >"$SERVER_PID_FILE"

  if ! wait_for_port "$SERVER_PORT"; then
    warn "服务端未能监听端口 $SERVER_PORT"
    tail -n 40 "$SERVER_LOG" >&2 || true
    return 1
  fi
}

start_electron() {
  if [[ -n "$(port_pids "$ELECTRON_PORT")" ]]; then
    if has_owned_port "$ELECTRON_PORT" electron; then
      log "Electron 开发服务端口 $ELECTRON_PORT 已由 AIRI 占用，跳过启动"
      return 0
    fi
    warn "Electron 开发服务端口 $ELECTRON_PORT 已被其他进程占用，请先处理该进程"
    return 1
  fi

  if [[ -n "$(port_pids "$ELECTRON_DEBUG_PORT")" ]]; then
    if has_owned_port "$ELECTRON_DEBUG_PORT" electron; then
      log "清理占用远程调试端口 $ELECTRON_DEBUG_PORT 的残留 AIRI Electron 进程"
      stop_port_processes "$ELECTRON_DEBUG_PORT" electron
    else
      warn "Electron 远程调试端口 $ELECTRON_DEBUG_PORT 已被其他进程占用，请先处理该进程"
      return 1
    fi
  fi

  log "启动 AIRI Electron，日志：$ELECTRON_LOG"
  (
    cd "$ROOT_DIR"
    exec env APP_REMOTE_DEBUG=true APP_REMOTE_DEBUG_PORT="$ELECTRON_DEBUG_PORT" nohup pnpm -F @proj-airi/stage-tamagotchi dev
  ) >>"$ELECTRON_LOG" 2>&1 < /dev/null &
  echo "$!" >"$ELECTRON_PID_FILE"

  if ! wait_for_port "$ELECTRON_PORT"; then
    warn "Electron 开发服务未能监听端口 $ELECTRON_PORT"
    tail -n 40 "$ELECTRON_LOG" >&2 || true
    return 1
  fi
  if ! wait_for_port "$ELECTRON_DEBUG_PORT"; then
    warn "Electron 远程调试服务未能监听端口 $ELECTRON_DEBUG_PORT"
    tail -n 40 "$ELECTRON_LOG" >&2 || true
    return 1
  fi
}

start_all() {
  start_server
  start_electron
  log 'AIRI 已启动：服务端 http://localhost:3000，Electron 页面 http://localhost:5173'
}

describe_port() {
  local port="$1"
  local kind="$2"
  local pid

  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if is_airi_process "$pid" "$kind"; then
      printf '运行中（PID %s）' "$pid"
    else
      printf '被其他进程占用（PID %s）' "$pid"
    fi
    return 0
  done < <(port_pids "$port")

  printf '未运行'
}

status_all() {
  printf '服务端：'
  describe_port "$SERVER_PORT" server
  printf '\nElectron：'
  describe_port "$ELECTRON_PORT" electron
  printf '\nElectron 远程调试：'
  describe_port "$ELECTRON_DEBUG_PORT" electron
  printf '\n日志目录：%s\n' "$LOG_DIR"
}

usage() {
  cat <<'EOF'
用法：
  ./scripts/start-airi.sh start    启动未运行的服务
  ./scripts/start-airi.sh restart  停止并重新启动服务
  ./scripts/start-airi.sh stop     停止服务
  ./scripts/start-airi.sh status   查看服务状态
EOF
}

main() {
  local action="${1:-start}"

  case "$action" in
    start|restart|stop)
      acquire_operation_lock
      ;;
  esac

  case "$action" in
    start)
      start_all
      ;;
    restart)
      stop_all
      start_all
      ;;
    stop)
      stop_all
      ;;
    status)
      status_all
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      usage >&2
      return 2
      ;;
  esac
}

main "$@"
