"""Converte presets .prst da Valeton GP-50 para o formato da GP-5.

Formato (engenharia reversa a partir de presets de fabrica dos dois aparelhos):
  0x00-0x0F  modelo ("GP-50" / "GP-5"), preenchido com zeros
  0x10-0x13  00 00 01 00
  0x14       CRC-8 (poly 0x07, init 0) dos bytes 0x15..fim do arquivo
  0x15-0x18  FF FF FF FF
  0x19-0x28  nome do preset (16 bytes)
  0x29-...   blocos TLV: tag u16 LE, tamanho u16 LE, valor
     0x00FF  identificacao (0x0002 = ID do aparelho)
     0x0000  versao
     0x0001  globais (GP-50 tem 10 campos, GP-5 so 0x2001 e 0x2002, ambos u32)
     0x0002  efeitos (ordem, modelos e parametros) - identico nos dois aparelhos
     0x0003  8 bytes na GP-5, 8 ou 10 na GP-50

Uso: python gp50_para_gp5.py <pasta_ou_arquivo_gp50> [...] -o <pasta_saida>
"""
import argparse
import struct
import sys
from pathlib import Path

GP5_DEVICE_ID = bytes.fromhex('0a454d51')
GP50_DEVICE_ID = b'GP50'


def crc8(data):
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def read_tlv(data):
    """Retorna lista de (tag, valor); ignora bytes soltos no final."""
    items, off = [], 0
    while off + 4 <= len(data):
        tag, size = struct.unpack_from('<HH', data, off)
        if off + 4 + size > len(data):
            break
        items.append((tag, data[off + 4:off + 4 + size]))
        off += 4 + size
    return items


def tlv(tag, value):
    return struct.pack('<HH', tag, len(value)) + value


def convert(src):
    if src[:5] != b'GP-50':
        raise ValueError('nao e um preset da GP-50')
    sections = dict(read_tlv(src[0x29:]))

    ident = dict(read_tlv(sections[0x00FF]))
    if ident.get(0x0002) != GP50_DEVICE_ID:
        raise ValueError('ID de aparelho inesperado')
    ident[0x0002] = GP5_DEVICE_ID

    glob = dict(read_tlv(sections[0x0001]))
    gp5_glob = b''.join(
        tlv(tag, glob[tag].ljust(4, b'\0')[:4]) for tag in (0x2001, 0x2002)
    )

    body = (
        tlv(0x00FF, b''.join(tlv(t, v) for t, v in ident.items()))
        + tlv(0x0000, sections[0x0000])
        + tlv(0x0001, gp5_glob)
        + tlv(0x0002, sections[0x0002])
        + tlv(0x0003, sections[0x0003][:8])
    )
    header = bytearray(b'GP-5'.ljust(0x10, b'\0') + b'\0\0\x01\0' + b'\0' + b'\xff' * 4)
    out = header + src[0x19:0x29] + body
    out[0x14] = crc8(out[0x15:])
    return bytes(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('entrada', nargs='+', type=Path)
    ap.add_argument('-o', '--saida', type=Path, required=True)
    args = ap.parse_args()

    files = []
    for p in args.entrada:
        files += sorted(p.glob('*.prst')) if p.is_dir() else [p]
    args.saida.mkdir(parents=True, exist_ok=True)

    erros = 0
    for f in files:
        try:
            data = convert(f.read_bytes())
        except (ValueError, KeyError) as e:
            print(f'ERRO  {f.name}: {e}')
            erros += 1
            continue
        (args.saida / f.name).write_bytes(data)
        print(f'OK    {f.name}')
    print(f'{len(files) - erros} convertidos, {erros} com erro -> {args.saida}')
    return 1 if erros else 0


if __name__ == '__main__':
    sys.exit(main())
