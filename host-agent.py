#!/usr/bin/env python3
"""DeskRTC host-control agent for explicitly approved support sessions."""

from __future__ import annotations

import argparse
import sys
from urllib.parse import urlparse

import pyautogui
import pyperclip
import socketio

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.01

SPECIAL_KEYS = {
    'enter': 'enter', 'backspace': 'backspace', 'tab': 'tab', 'escape': 'esc',
    'space': 'space', 'arrowup': 'up', 'arrowdown': 'down', 'arrowleft': 'left',
    'arrowright': 'right', 'delete': 'delete', 'pageup': 'pageup',
    'pagedown': 'pagedown', 'home': 'home', 'end': 'end', 'insert': 'insert',
    'control': 'ctrl', 'alt': 'alt', 'shift': 'shift', 'meta': 'winleft',
    'f1': 'f1', 'f2': 'f2', 'f3': 'f3', 'f4': 'f4', 'f5': 'f5', 'f6': 'f6',
    'f7': 'f7', 'f8': 'f8', 'f9': 'f9', 'f10': 'f10', 'f11': 'f11', 'f12': 'f12',
}
ALLOWED_BUTTONS = {'left', 'middle', 'right'}
MODIFIERS = {'control', 'alt', 'shift', 'meta'}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='DeskRTC host control agent')
    parser.add_argument('--id', required=True, help='Host session ID')
    parser.add_argument('--server', required=True, help='HTTPS server or local HTTP URL')
    parser.add_argument('--agent-token', required=True, help='One-session agent credential')
    return parser.parse_args()


def normalize_host_id(value: str) -> str:
    host_id = ''.join(ch for ch in str(value) if ch.isdigit())[:12]
    if len(host_id) < 9:
        raise ValueError('host ID must contain 9 to 12 digits')
    return host_id


def validate_server_url(value: str) -> str:
    parsed = urlparse(str(value).strip())
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('server URL must not contain credentials, query, or fragment')
    if parsed.scheme == 'https' and parsed.hostname:
        return f'https://{parsed.netloc}'
    if parsed.scheme == 'http' and parsed.hostname in {'127.0.0.1', 'localhost', '::1'}:
        return f'http://{parsed.netloc}'
    raise ValueError('server must use HTTPS, or HTTP on a loopback address')


def normalize_token(value: str) -> str:
    token = str(value).strip()
    if not 32 <= len(token) <= 128 or any(ch.isspace() for ch in token):
        raise ValueError('agent token is invalid')
    return token


def clamp01(value: object) -> float:
    number = float(value)
    if not 0.0 <= number <= 1.0:
        raise ValueError('coordinate out of bounds')
    return number


def key_name(value: object) -> str:
    key = str(value or '').lower()
    if key in SPECIAL_KEYS:
        return SPECIAL_KEYS[key]
    if len(key) == 1 and key.isprintable():
        return key
    raise ValueError('unsupported key')


def handle_control_event(event: object, screen_width: int, screen_height: int) -> None:
    if not isinstance(event, dict):
        raise ValueError('event must be an object')
    event_type = event.get('type')
    if event_type == 'move':
        pyautogui.moveTo(int(clamp01(event.get('x')) * screen_width), int(clamp01(event.get('y')) * screen_height))
    elif event_type == 'click':
        button = str(event.get('button', 'left')).lower()
        if button not in ALLOWED_BUTTONS:
            raise ValueError('unsupported mouse button')
        pyautogui.click(button=button)
    elif event_type == 'scroll':
        delta = int(event.get('delta'))
        if not -100 <= delta <= 100:
            raise ValueError('scroll delta out of bounds')
        pyautogui.scroll(delta)
    elif event_type == 'key':
        pyautogui.press(key_name(event.get('key')))
    elif event_type == 'hotkey':
        raw_keys = event.get('keys')
        if not isinstance(raw_keys, list) or not 2 <= len(raw_keys) <= 4:
            raise ValueError('hotkey must contain two to four keys')
        normalized_names = [str(key or '').lower() for key in raw_keys]
        if not any(key in MODIFIERS for key in normalized_names):
            raise ValueError('hotkey requires a modifier')
        pyautogui.hotkey(*[key_name(key) for key in raw_keys])
    elif event_type == 'clipboard':
        text = str(event.get('text', ''))
        if len(text) > 4096 or '\x00' in text:
            raise ValueError('clipboard text is invalid or too large')
        pyperclip.copy(text)
    else:
        raise ValueError('unsupported event type')


def main() -> int:
    args = parse_args()
    try:
        host_id = normalize_host_id(args.id)
        server_url = validate_server_url(args.server)
        agent_token = normalize_token(args.agent_token)
    except ValueError as exc:
        print(f'[agent] configuration error: {exc}', file=sys.stderr)
        return 2

    screen_width, screen_height = pyautogui.size()
    sio = socketio.Client(reconnection=True, reconnection_attempts=10, reconnection_delay=2)

    @sio.event
    def connect() -> None:
        print(f'[agent] connected; registering host {host_id}')
        sio.emit('register-agent', {'hostId': host_id, 'agentToken': agent_token})

    @sio.event
    def disconnect() -> None:
        print('[agent] disconnected')

    @sio.on('registered')
    def on_registered(_data: object) -> None:
        print('[agent] authorized for this host session')

    @sio.on('error-msg')
    def on_error(message: object) -> None:
        print(f'[agent] server rejected request: {message}', file=sys.stderr)

    @sio.on('host-disconnected')
    def on_host_disconnected() -> None:
        print('[agent] host session ended')
        sio.disconnect()

    @sio.on('control-event')
    def on_control_event(event: object) -> None:
        try:
            handle_control_event(event, screen_width, screen_height)
        except Exception as exc:  # PyAutoGUI can raise platform-specific errors.
            event_type = event.get('type') if isinstance(event, dict) else 'unknown'
            print(f'[agent] rejected {event_type}: {exc}', file=sys.stderr)

    print(f'[agent] starting host={host_id} server={server_url} screen={screen_width}x{screen_height}')
    try:
        sio.connect(server_url, transports=['websocket', 'polling'])
        sio.wait()
        return 0
    except KeyboardInterrupt:
        print('\n[agent] stopped by user')
        return 0
    except Exception as exc:
        print(f'[agent] connection error: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
