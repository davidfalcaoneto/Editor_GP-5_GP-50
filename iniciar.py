"""Abre o Editor GP-5 / GP-50 no navegador.

Web MIDI so funciona em pagina servida por http://localhost (nao por file://),
por isso este script sobe um servidor local na pasta app/ e abre o Chrome/Edge.
Uso: python iniciar.py   (Ctrl+C para encerrar)
"""
import functools
import http.server
import subprocess
import webbrowser
from pathlib import Path

PORT = 8050
APP = Path(__file__).resolve().parent / 'app'
URL = f'http://localhost:{PORT}/'

BROWSERS = [
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
]


def open_browser():
    for exe in BROWSERS:
        if Path(exe).exists():
            subprocess.Popen([exe, URL])
            return
    webbrowser.open(URL)


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """Manda o navegador sempre buscar a versao atual dos arquivos do editor."""

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


handler = functools.partial(NoCacheHandler, directory=str(APP))
with http.server.ThreadingHTTPServer(('localhost', PORT), handler) as srv:
    print(f'Editor em {URL}  (Ctrl+C para encerrar)')
    open_browser()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
