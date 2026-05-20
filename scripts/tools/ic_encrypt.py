#!/usr/bin/env python3
"""
ic-encrypt — CLI tool to encrypt .lua → .lue (IOSControl format)

Replicates ICEncrypt (ScriptEncrypt.m) AES-256-CBC encryption exactly.
Output .lue files are decryptable by IOSControl's LuaEngine on device.

Usage:
  python3 ic_encrypt.py PokemonLoader.lua                    # → PokemonLoader.lue (built-in key)
  python3 ic_encrypt.py PokemonLoader.lua -o output.lue      # custom output path
  python3 ic_encrypt.py PokemonLoader.lua -p "mypassword"    # password-protected

Format (.lue v2):
  [magic:4][flags:1][salt:16][iv:16][ciphertext:N][hmac:32]
  magic = "LUE\\x02"
  flags = 0x01 if password, 0x00 if built-in key
"""

import argparse
import hashlib
import hmac as hmac_mod
import os
import struct
import sys

# pip install pycryptodome (or pycryptodomex)
try:
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import pad
except ImportError:
    try:
        from Cryptodome.Cipher import AES
        from Cryptodome.Util.Padding import pad
    except ImportError:
        print("❌ Cần cài pycryptodome:")
        print("   pip3 install pycryptodome")
        sys.exit(1)


# ═══════════════════════════════════════════
# Built-in key derivation (replicate ScriptEncrypt.m)
# ═══════════════════════════════════════════

def _ic_seed() -> bytes:
    """Replicate scattered seed from ScriptEncrypt.m"""
    s = bytearray(16)
    # _ic_seed_a
    s[0] = 0xE3 ^ 0x40   # 0xA3
    s[1] = 0x4E ^ 0x31   # 0x7F
    s[2] = 0xB4 ^ 0xA9   # 0x1D
    s[3] = 0x9C ^ 0x74   # 0xE8
    # _ic_seed_b
    s[4] = 0x95 ^ 0xDE   # 0x4B
    s[5] = 0x9A ^ 0x08   # 0x92
    s[6] = 0xAD ^ 0x6B   # 0xC6
    s[7] = 0xF6 ^ 0xF5   # 0x03
    # _ic_seed_c
    s[8] = 0x93 ^ 0x42   # 0xD1
    s[9] = 0xBD ^ 0xE7   # 0x5A
    s[10] = 0x9D ^ 0x13  # 0x8E
    s[11] = 0xB1 ^ 0x8A  # 0x3B
    # _ic_seed_d
    s[12] = 0x9D ^ 0x69  # 0xF4
    s[13] = 0xA0 ^ 0xC3  # 0x63
    s[14] = 0x80 ^ 0x2F  # 0xAF
    s[15] = 0x87 ^ 0xB6  # 0x31
    return bytes(s)


def _ic_ks() -> bytes:
    """Derivation salt from ScriptEncrypt.m: 'ic_k_s2'"""
    return bytes([0x69, 0x63, 0x5F, 0x6B, 0x5F, 0x73, 0x32])


def ic_get_builtin_key() -> bytes:
    """PBKDF2(seed, salt='ic_k_s2', iterations=2000) → 32 bytes"""
    seed = _ic_seed()
    salt = _ic_ks()
    return hashlib.pbkdf2_hmac('sha256', seed, salt, 2000, dklen=32)


def ic_derive_key(password: str, salt: bytes) -> bytes:
    """PBKDF2(password, salt, iterations=10000) → 32 bytes"""
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 10000, dklen=32)


# ═══════════════════════════════════════════
# Encrypt
# ═══════════════════════════════════════════

IC_LUE_MAGIC_V2 = b"LUE\x02"
IC_LUE_SALT_LEN = 16
IC_LUE_IV_LEN = 16
IC_LUE_HMAC_LEN = 32
IC_LUE_FLAG_HAS_PASSWORD = 0x01


def encrypt_lua(source: str, password: str = None) -> bytes:
    """
    Encrypt Lua source → .lue v2 binary.
    Exactly matches ICEncrypt +encryptLuaSource:password:error:
    """
    plaintext = source.encode('utf-8')
    has_password = bool(password)

    # Random salt + IV
    salt = os.urandom(IC_LUE_SALT_LEN)
    iv = os.urandom(IC_LUE_IV_LEN)

    # Key
    if has_password:
        key = ic_derive_key(password, salt)
    else:
        key = ic_get_builtin_key()

    # AES-256-CBC encrypt with PKCS7 padding
    cipher = AES.new(key, AES.MODE_CBC, iv)
    ciphertext = cipher.encrypt(pad(plaintext, AES.block_size))

    # Build .lue v2: [magic][flags][salt][iv][ciphertext]
    flags = IC_LUE_FLAG_HAS_PASSWORD if has_password else 0
    lue_data = bytearray()
    lue_data += IC_LUE_MAGIC_V2
    lue_data += struct.pack('B', flags)
    lue_data += salt
    lue_data += iv
    lue_data += ciphertext

    # HMAC-SHA256 over entire content (tamper detection)
    h = hmac_mod.new(key, bytes(lue_data), hashlib.sha256).digest()
    lue_data += h

    return bytes(lue_data)


def decrypt_lue(data: bytes, password: str = None) -> str:
    """Decrypt .lue → Lua source (for verification)"""
    if len(data) < 37 or data[:3] != b"LUE":
        raise ValueError("Not a valid .lue file")

    is_v2 = (data[3] == 0x02)
    flags = data[4]
    has_password = bool(flags & IC_LUE_FLAG_HAS_PASSWORD)

    salt = data[5:5 + IC_LUE_SALT_LEN]
    iv = data[5 + IC_LUE_SALT_LEN:5 + IC_LUE_SALT_LEN + IC_LUE_IV_LEN]

    header_len = 5 + IC_LUE_SALT_LEN + IC_LUE_IV_LEN  # 37

    if is_v2:
        ciphertext = data[header_len:-IC_LUE_HMAC_LEN]
        stored_hmac = data[-IC_LUE_HMAC_LEN:]
    else:
        ciphertext = data[header_len:]
        stored_hmac = None

    # Key
    if has_password:
        if not password:
            raise ValueError("Password required")
        key = ic_derive_key(password, salt)
    else:
        key = ic_get_builtin_key()

    # Verify HMAC (v2)
    if is_v2 and stored_hmac:
        content = data[:-IC_LUE_HMAC_LEN]
        computed = hmac_mod.new(key, content, hashlib.sha256).digest()
        if computed != stored_hmac:
            raise ValueError("HMAC mismatch — wrong password or file corrupted")

    # Decrypt
    cipher = AES.new(key, AES.MODE_CBC, iv)
    padded = cipher.decrypt(ciphertext)

    # Remove PKCS7 padding
    pad_len = padded[-1]
    if pad_len > 16 or pad_len == 0:
        raise ValueError("Invalid padding")
    plaintext = padded[:-pad_len]

    return plaintext.decode('utf-8')


# ═══════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="🔐 ic-encrypt — Encrypt .lua → .lue (IOSControl format)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s PokemonLoader.lua                    # → PokemonLoader.lue
  %(prog)s PokemonLoader.lua -o /tmp/out.lue    # custom output
  %(prog)s PokemonLoader.lua -p "secret"        # password-protected
  %(prog)s --verify PokemonLoader.lue           # decrypt + verify
        """
    )
    parser.add_argument("input", help="Input .lua file (or .lue for --verify)")
    parser.add_argument("-o", "--output", help="Output .lue path (default: same name + .lue)")
    parser.add_argument("-p", "--password", help="Password (optional, default: built-in key)")
    parser.add_argument("--verify", action="store_true", help="Decrypt .lue and print first 5 lines")
    args = parser.parse_args()

    if args.verify:
        # Decrypt mode
        with open(args.input, "rb") as f:
            data = f.read()
        try:
            source = decrypt_lue(data, args.password)
            lines = source.split('\n')
            print(f"✅ Decrypt OK — {len(source)} bytes, {len(lines)} lines")
            print("─" * 50)
            for line in lines[:5]:
                print(line)
            if len(lines) > 5:
                print(f"... ({len(lines) - 5} more lines)")
        except Exception as e:
            print(f"❌ Decrypt failed: {e}")
            sys.exit(1)
    else:
        # Encrypt mode
        if not os.path.isfile(args.input):
            print(f"❌ File not found: {args.input}")
            sys.exit(1)

        with open(args.input, "r", encoding="utf-8") as f:
            source = f.read()

        output = args.output or os.path.splitext(args.input)[0] + ".lue"
        lue_data = encrypt_lua(source, args.password)

        with open(output, "wb") as f:
            f.write(lue_data)

        size_kb = len(lue_data) / 1024
        print(f"✅ Encrypted: {args.input} → {output}")
        print(f"   Size: {size_kb:.1f} KB ({len(lue_data)} bytes)")
        print(f"   Password: {'YES' if args.password else 'NO (built-in key)'}")
        print(f"   Format: LUE v2 (AES-256-CBC + HMAC-SHA256)")

        # Auto-verify
        try:
            verify = decrypt_lue(lue_data, args.password)
            if verify == source:
                print(f"   Verify: ✅ roundtrip OK")
            else:
                print(f"   Verify: ⚠️ mismatch!")
        except Exception as e:
            print(f"   Verify: ❌ {e}")


if __name__ == "__main__":
    main()
