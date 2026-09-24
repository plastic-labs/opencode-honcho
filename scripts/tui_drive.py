#!/usr/bin/env python3
"""Drive a TUI in a pseudo-terminal headlessly and take text + PNG screenshots.

usage: tui_drive.py OUTDIR CMD... -- STEP...
steps:  wait:<sec>  type:<text>  key:<enter|esc|tab|down|up|ctrl-c>  snap:<name>
"""
import fcntl, os, pty, select, signal, struct, sys, termios, time

import pyte

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # text snapshots only
    Image = None

FONTS = ["/System/Library/Fonts/Menlo.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"]

COLS, ROWS = 120, 40
KEYS = {"enter": "\r", "esc": "\x1b", "tab": "\t", "down": "\x1b[B", "up": "\x1b[A", "ctrl-c": "\x03", "space": " "}


def render_png(lines, path):
    font_path = next((f for f in FONTS if os.path.exists(f)), None)
    if Image is None or font_path is None:
        return
    font = ImageFont.truetype(font_path, 14)
    cw, ch = font.getbbox("M")[2], 18
    img = Image.new("RGB", (cw * COLS + 20, ch * ROWS + 20), (24, 24, 28))
    draw = ImageDraw.Draw(img)
    for y, line in enumerate(lines):
        draw.text((10, 10 + y * ch), line, font=font, fill=(220, 220, 220))
    img.save(path)


def main():
    outdir = sys.argv[1]
    sep = sys.argv.index("--")
    cmd, steps = sys.argv[2:sep], sys.argv[sep + 1 :]
    os.makedirs(outdir, exist_ok=True)

    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"], os.environ["LINES"] = str(COLS), str(ROWS)
        os.execvp(cmd[0], cmd)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.ByteStream(screen)

    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if fd in r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                stream.feed(data)

    def snapshot(name):
        lines = [line.rstrip() for line in screen.display]
        text = "\n".join(lines).rstrip() + "\n"
        with open(os.path.join(outdir, f"{name}.txt"), "w") as f:
            f.write(text)
        render_png(lines, os.path.join(outdir, f"{name}.png"))
        print(f"--- {name} ---")
        print(text)

    for step in steps:
        kind, _, arg = step.partition(":")
        if kind == "wait":
            pump(float(arg))
        elif kind == "type":
            for ch in arg:
                os.write(fd, ch.encode())
                pump(0.03)
        elif kind == "key":
            os.write(fd, KEYS[arg].encode())
            pump(0.2)
        elif kind == "snap":
            pump(0.3)
            snapshot(arg)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass


if __name__ == "__main__":
    main()
