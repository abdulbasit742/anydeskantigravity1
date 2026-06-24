#!/usr/bin/env python3
"""
DeskRTC Host Control Agent

Runs on the host machine after the host user gives permission. It receives
remote-control events from the DeskRTC signaling server and applies them using
PyAutoGUI. Use only on machines you own or have explicit permission to support.
"""

import argparse
import sys
import time
import threading

import pyautogui
import pyperclip
import socketio

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.0

parser = argparse.ArgumentParser(description='DeskRTC host control agent')
parser.add_argument('--id', required=True, help='Host session ID')
parser.add_argument('--server', required=True, help='Server URL, e.g. http://localhost:3000')
args = parser.parse_args()

HOST_ID = ''.join(ch for ch in args.id if ch.isdigit())[:12]
SERVER_URL = args.server

if not HOST_ID:
    print('Invalid host ID', file=sys.stderr)
    sys.exit(2)

sio = socketio.Client(reconnection=True, reconnection_attempts=10, reconnection_delay=2)
SCREEN_W, SCREEN_H = pyautogui.size()
_last_clipboard = ''

KEY_MAP = {
    'enter': 'enter', 'backspace': 'backspace', 'tab': 'tab', 'escape': 'esc',
    'space': 'space', 'arrowup': 'up', 'arrowdown': 'down', 'arrowleft': 'left', 'arrowright': 'right',
    'delete': 'delete', 'pageup': 'pageup', 'pagedown': 'pagedown', 'home': 'home', 'end': 'end',
    'control': 'ctrl', 'alt': 'alt', 'shift': 'shift', 'meta': 'winleft'
}


def clamp01(value):
    try:
        return max(0.0, min(1.0, float(value)))
    except Exception:
        return 0.0


def key_name(value):
    value = str(value or '').lower()
    return KEY_MAP.get(value, value if len(value) > 1 else value)


@sio.event
def connect():
    print(f'[agent] connected, registering host {HOST_ID}')
    sio.emit('register-agent', {'hostId': HOST_ID})


@sio.event
def disconnect():
    print('[agent] disconnected')


@sio.on('registered')
def on_registered(data):
    print(f'[agent] registered: {data}')


@sio.on('host-disconnected')
def on_host_disconnected():
    print('[agent] host session ended')
    sio.disconnect()


@sio.on('control-event')
def on_control_event(event):
    event_type = event.get('type')
    try:
        if event_type == 'move':
            pyautogui.moveTo(int(clamp01(event.get('x')) * SCREEN_W), int(clamp01(event.get('y')) * SCREEN_H))
        elif event_type == 'click':
            pyautogui.click(button=event.get('button', 'left'))
        elif event_type == 'scroll':
            pyautogui.scroll(int(event.get('delta', 0)))
        elif event_type == 'key':
            key = key_name(event.get('key'))
            if key:
                pyautogui.press(key)
        elif event_type == 'hotkey':
            keys = [key_name(k) for k in event.get('keys', []) if key_name(k)]
            if keys:
                pyautogui.hotkey(*keys)
        elif event_type == 'clipboard':
            pyperclip.copy(str(event.get('text', '')))
    except Exception as exc:
        print(f'[agent] failed to handle {event_type}: {exc}')


def clipboard_loop():
    global _last_clipboard
    while True:
        try:
            current = pyperclip.paste()
            if current and current != _last_clipboard:
                _last_clipboard = current
        except Exception:
            pass
        time.sleep(2)


if __name__ == '__main__':
    print('[agent] starting DeskRTC host agent')
    print(f'[agent] host={HOST_ID} server={SERVER_URL} screen={SCREEN_W}x{SCREEN_H}')
    threading.Thread(target=clipboard_loop, daemon=True).start()
    try:
        sio.connect(SERVER_URL, transports=['websocket', 'polling'])
        sio.wait()
    except KeyboardInterrupt:
        print('\n[agent] stopped by user')
    except Exception as exc:
        print(f'[agent] connection error: {exc}', file=sys.stderr)
        sys.exit(1)
