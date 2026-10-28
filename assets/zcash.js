/*
 * Zectill engine: Zcash address and ZIP-321 primitives.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ZcashKit = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ================================ bytes ================================ */

  const utf8 = new TextEncoder();
  const utf8Strict = new TextDecoder("utf-8", { fatal: true });
  const toHex = (b) =>
    Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const fromHex = (s) =>
    Uint8Array.from(String(s).match(/../g) || [], (h) => parseInt(h, 16));
  const xor = (a, b) => a.map((x, i) => x ^ b[i]);

  function concatBytes(...parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  /* ============================ BLAKE2b (RFC 7693) ============================
     64-bit words are held as little-endian pairs of uint32 (low word first). */

  const B2B_IV = new Uint32Array([
    0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372,
    0x5f1d36f1, 0xa54ff53a, 0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c,
    0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
  ]);
  const SIGMA = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15,
    13, 6, 1, 12, 0, 2, 11, 7, 5, 3, 11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6,
    7, 1, 9, 4, 7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8, 9, 0, 5,
    7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13, 2, 12, 6, 10, 0, 11, 8, 3, 4,
    13, 7, 5, 15, 14, 1, 9, 12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8,
    11, 13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10, 6, 15, 14, 9, 11,
    3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5, 10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14,
    3, 12, 13, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10,
    4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  ].map((x) => x * 2);
  const V = new Uint32Array(32),
    M = new Uint32Array(32);

  function add64(a, b) {
    const lo = V[a] + V[b];
    V[a + 1] = V[a + 1] + V[b + 1] + (lo > 0xffffffff ? 1 : 0);
    V[a] = lo;
  }
  function add64w(a, lo0, hi0) {
    const lo = V[a] + lo0;
    V[a + 1] = V[a + 1] + hi0 + (lo > 0xffffffff ? 1 : 0);
    V[a] = lo;
  }

  function mix(a, b, c, d, ix, iy) {
    add64(a, b);
    add64w(a, M[ix], M[ix + 1]);
    let x0 = V[d] ^ V[a],
      x1 = V[d + 1] ^ V[a + 1];
    V[d] = x1;
    V[d + 1] = x0; // rotr 32
    add64(c, d);
    x0 = V[b] ^ V[c];
    x1 = V[b + 1] ^ V[c + 1];
    V[b] = (x0 >>> 24) ^ (x1 << 8);
    V[b + 1] = (x1 >>> 24) ^ (x0 << 8); // rotr 24
    add64(a, b);
    add64w(a, M[iy], M[iy + 1]);
    x0 = V[d] ^ V[a];
    x1 = V[d + 1] ^ V[a + 1];
    V[d] = (x0 >>> 16) ^ (x1 << 16);
    V[d + 1] = (x1 >>> 16) ^ (x0 << 16); // rotr 16
    add64(c, d);
    x0 = V[b] ^ V[c];
    x1 = V[b + 1] ^ V[c + 1];
    V[b] = (x1 >>> 31) ^ (x0 << 1);
    V[b + 1] = (x0 >>> 31) ^ (x1 << 1); // rotr 63
  }

  function compress(h, block, t, last) {
    for (let i = 0; i < 16; i++) {
      V[i] = h[i];
      V[i + 16] = B2B_IV[i];
    }
    V[24] ^= t;
    V[25] ^= (t / 0x100000000) >>> 0;
    if (last) {
      V[28] = ~V[28];
      V[29] = ~V[29];
    }
    for (let i = 0; i < 32; i++)
      M[i] =
        block[4 * i] |
        (block[4 * i + 1] << 8) |
        (block[4 * i + 2] << 16) |
        (block[4 * i + 3] << 24);
    for (let r = 0; r < 12; r++) {
      const s = r * 16;
      mix(0, 8, 16, 24, SIGMA[s], SIGMA[s + 1]);
      mix(2, 10, 18, 26, SIGMA[s + 2], SIGMA[s + 3]);
      mix(4, 12, 20, 28, SIGMA[s + 4], SIGMA[s + 5]);
      mix(6, 14, 22, 30, SIGMA[s + 6], SIGMA[s + 7]);
      mix(0, 10, 20, 30, SIGMA[s + 8], SIGMA[s + 9]);
      mix(2, 12, 22, 24, SIGMA[s + 10], SIGMA[s + 11]);
      mix(4, 14, 16, 26, SIGMA[s + 12], SIGMA[s + 13]);
      mix(6, 8, 18, 28, SIGMA[s + 14], SIGMA[s + 15]);
    }
    for (let i = 0; i < 16; i++) h[i] ^= V[i] ^ V[i + 16];
  }

  /** One-shot unkeyed BLAKE2b. `personal` is an optional 16-byte personalisation string. */
  function blake2b(input, outlen = 64, personal = null) {
    if (outlen < 1 || outlen > 64)
      throw new RangeError("BLAKE2b output length must be 1..64");
    const h = new Uint32Array(B2B_IV);
    h[0] ^= 0x01010000 ^ outlen;
    if (personal)
      for (let i = 0; i < 4; i++) {
        h[12 + i] ^=
          personal[4 * i] |
          (personal[4 * i + 1] << 8) |
          (personal[4 * i + 2] << 16) |
          (personal[4 * i + 3] << 24);
      }
    const block = new Uint8Array(128);
    let t = 0,
      pos = 0;
    while (input.length - pos > 128) {
      block.set(input.subarray(pos, pos + 128));
      t += 128;
      compress(h, block, t, false);
      pos += 128;
    }
    block.fill(0);
    block.set(input.subarray(pos));
    t += input.length - pos;
    compress(h, block, t, true);
    const out = new Uint8Array(outlen);
    for (let i = 0; i < outlen; i++) out[i] = h[i >> 2] >>> (8 * (i & 3));
    return out;
  }

  /* =========================== SHA-256 (FIPS 180-4) =========================== */

  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const ror = (x, n) => (x >>> n) | (x << (32 - n));

  function sha256(data) {
    const H = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19,
    ]);
    const len = data.length,
      buf = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    buf.set(data);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer),
      bits = len * 8;
    dv.setUint32(buf.length - 8, Math.floor(bits / 0x100000000));
    dv.setUint32(buf.length - 4, bits >>> 0);
    const W = new Uint32Array(64);
    for (let o = 0; o < buf.length; o += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + 4 * i);
      for (let i = 16; i < 64; i++) {
        const a = W[i - 15],
          b = W[i - 2];
        W[i] =
          W[i - 16] +
          (ror(a, 7) ^ ror(a, 18) ^ (a >>> 3)) +
          W[i - 7] +
          (ror(b, 17) ^ ror(b, 19) ^ (b >>> 10));
      }
      let a = H[0],
        b = H[1],
        c = H[2],
        d = H[3],
        e = H[4],
        f = H[5],
        g = H[6],
        h = H[7];
      for (let i = 0; i < 64; i++) {
        const t1 =
          (h +
            (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) +
            ((e & f) ^ (~e & g)) +
            K256[i] +
            W[i]) >>>
          0;
        const t2 =
          ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) +
            ((a & b) ^ (a & c) ^ (b & c))) >>>
          0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      H[0] += a;
      H[1] += b;
      H[2] += c;
      H[3] += d;
      H[4] += e;
      H[5] += f;
      H[6] += g;
      H[7] += h;
    }
    const out = new Uint8Array(32),
      odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(4 * i, H[i]);
    return out;
  }

  /* ============================ F4Jumble (ZIP 316) ============================ */

  const F4_MIN = 48,
    F4_MAX = 4194368,
    F4_HASH = 64;
  const PERS_H = utf8.encode("UA_F4Jumble_H"),
    PERS_G = utf8.encode("UA_F4Jumble_G");

  function f4Pers(base, a, b, c) {
    const p = new Uint8Array(16);
    p.set(base);
    p[13] = a;
    p[14] = b;
    p[15] = c;
    return p;
  }
  const f4H = (i, u, lenL) => blake2b(u, lenL, f4Pers(PERS_H, i, 0, 0));
  function f4G(i, u, lenR) {
    const out = new Uint8Array(lenR);
    for (let j = 0; j * F4_HASH < lenR; j++) {
      const blk = blake2b(u, F4_HASH, f4Pers(PERS_G, i, j & 0xff, j >>> 8));
      out.set(
        blk.subarray(0, Math.min(F4_HASH, lenR - j * F4_HASH)),
        j * F4_HASH,
      );
    }
    return out;
  }

  /** F4Jumble (inverse = false) or F4Jumble⁻¹ (inverse = true). Throws RangeError on bad length. */
  function f4jumble(msg, inverse) {
    const n = msg.length;
    if (n < F4_MIN || n > F4_MAX)
      throw new RangeError("F4Jumble input length out of range");
    const lenL = Math.min(F4_HASH, n >> 1),
      lenR = n - lenL;
    const left = msg.slice(0, lenL),
      right = msg.slice(lenL);
    if (!inverse) {
      const x = xor(right, f4G(0, left, lenR));
      const y = xor(left, f4H(0, x, lenL));
      const d = xor(x, f4G(1, y, lenR));
      const c = xor(y, f4H(1, d, lenL));
      return concatBytes(c, d);
    }
    const y = xor(left, f4H(1, right, lenL));
    const x = xor(right, f4G(1, y, lenR));
    const a = xor(y, f4H(0, x, lenL));
    const b = xor(x, f4G(0, a, lenR));
    return concatBytes(a, b);
  }

  /* ===================== Bech32 / Bech32m (BIP 173 / 350) ===================== */

  const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const B32_CONST = { bech32: 1, bech32m: 0x2bc830a3 };

  function polymod(values) {
    const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const top = chk >>> 25;
      chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
      for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk = (chk ^ G[i]) >>> 0;
    }
    return chk;
  }
  const hrpExpand = (hrp) =>
    [...hrp]
      .map((c) => c.charCodeAt(0) >> 5)
      .concat(
        0,
        [...hrp].map((c) => c.charCodeAt(0) & 31),
      );

  /** Decodes without a length limit. Returns { ok, hrp, variant, words } or { ok:false, code, error }. */
  function bech32Decode(str) {
    const s0 = String(str);
    if (s0 !== s0.toLowerCase() && s0 !== s0.toUpperCase())
      return fail(
        "mixed-case",
        "Mixes upper- and lower-case letters. Addresses are all one case.",
      );
    const s = s0.toLowerCase(),
      sep = s.lastIndexOf("1");
    if (sep < 1 || s.length - sep - 1 < 6)
      return fail("format", "Not a valid Bech32 string.");
    const hrp = s.slice(0, sep);
    for (const ch of hrp) {
      const c = ch.charCodeAt(0);
      if (c < 33 || c > 126)
        return fail("format", "Invalid characters in the address prefix.");
    }
    const words = [];
    for (const ch of s.slice(sep + 1)) {
      const v = B32.indexOf(ch);
      if (v < 0)
        return fail(
          "char",
          `The character "${ch}" cannot appear in this address (b, i, o and 1 are never used).`,
        );
      words.push(v);
    }
    const pm = polymod(hrpExpand(hrp).concat(words));
    const variant =
      pm === B32_CONST.bech32
        ? "bech32"
        : pm === B32_CONST.bech32m
          ? "bech32m"
          : null;
    if (!variant)
      return fail(
        "checksum",
        "Checksum mismatch: a character is wrong, missing or out of order.",
      );
    return { ok: true, hrp, variant, words: words.slice(0, -6) };
  }

  function bech32Encode(hrp, words, variant = "bech32m") {
    const pm =
      (polymod(hrpExpand(hrp).concat(words, [0, 0, 0, 0, 0, 0])) ^
        B32_CONST[variant]) >>>
      0;
    const chk = [0, 1, 2, 3, 4, 5].map((i) => (pm >>> (5 * (5 - i))) & 31);
    return (
      hrp +
      "1" +
      words
        .concat(chk)
        .map((w) => B32[w])
        .join("")
    );
  }

  /** Regroups bits (e.g. 5 → 8). Returns null when `pad` is false and the padding is invalid. */
  function convertBits(data, from, to, pad) {
    let acc = 0,
      bits = 0;
    const out = [],
      maxv = (1 << to) - 1,
      maxAcc = (1 << (from + to - 1)) - 1;
    for (const v of data) {
      acc = ((acc << from) | v) & maxAcc;
      bits += from;
      while (bits >= to) {
        bits -= to;
        out.push((acc >> bits) & maxv);
      }
    }
    if (pad) {
      if (bits) out.push((acc << (to - bits)) & maxv);
    } else if (bits >= from || (acc << (to - bits)) & maxv) return null;
    return out;
  }

  /* ================================ Base58Check ================================ */

  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  function base58Decode(s) {
    const bytes = [];
    for (const ch of s) {
      let carry = B58.indexOf(ch);
      if (carry < 0) return null;
      for (let j = 0; j < bytes.length; j++) {
        carry += bytes[j] * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry) {
        bytes.push(carry & 0xff);
        carry >>= 8;
      }
    }
    for (const ch of s) {
      if (ch !== "1") break;
      bytes.push(0);
    }
    return Uint8Array.from(bytes.reverse());
  }

  function base58CheckDecode(s) {
    const d = base58Decode(s);
    if (!d || d.length < 5) return null;
    const payload = d.subarray(0, d.length - 4),
      chk = sha256(sha256(payload));
    for (let i = 0; i < 4; i++) if (chk[i] !== d[d.length - 4 + i]) return null;
    return payload;
  }

  /* ========================== CompactSize (zcash_encoding) ========================== */

  const MAX_COMPACT = 0x02000000;

  function readCompactSize(buf, pos) {
    const need = (n) => {
      if (pos + n > buf.length)
        throw new UAError("truncated", "The address is truncated.");
    };
    need(1);
    const b = buf[pos];
    let value, size;
    if (b < 0xfd) {
      value = b;
      size = 1;
    } else if (b === 0xfd) {
      need(3);
      value = buf[pos + 1] | (buf[pos + 2] << 8);
      size = 3;
      if (value < 0xfd)
        throw new UAError("encoding", "Non-canonical size encoding.");
    } else if (b === 0xfe) {
      need(5);
      value =
        (buf[pos + 1] |
          (buf[pos + 2] << 8) |
          (buf[pos + 3] << 16) |
          (buf[pos + 4] << 24)) >>>
        0;
      size = 5;
      if (value < 0x10000)
        throw new UAError("encoding", "Non-canonical size encoding.");
    } else throw new UAError("encoding", "Size value is out of range.");
    if (value > MAX_COMPACT)
      throw new UAError("encoding", "Size value is out of range.");
    return { value, pos: pos + size };
  }

  function writeCompactSize(n) {
    if (n < 0xfd) return Uint8Array.of(n);
    if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >>> 8);
    return Uint8Array.of(
      0xfe,
      n & 0xff,
      (n >>> 8) & 0xff,
      (n >>> 16) & 0xff,
      n >>> 24,
    );
  }

  /* ======================= Unified Addresses (ZIP 316) ======================= */

  class UAError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  /* hrp -> [network, revision, transparent-including] */
  const UA_HRPS = {
    u: ["main", 0, false],
    utest: ["test", 0, false],
    uregtest: ["regtest", 0, false],
    zu: ["main", 2, false],
    zutest: ["test", 2, false],
    zuregtest: ["regtest", 2, false],
    tu: ["main", 2, true],
    tutest: ["test", 2, true],
    turegtest: ["regtest", 2, true],
  };
  const RECEIVERS = {
    0: {
      name: "p2pkh",
      label: "Transparent (P2PKH)",
      len: 20,
      transparent: true,
    },
    1: {
      name: "p2sh",
      label: "Transparent (P2SH)",
      len: 20,
      transparent: true,
    },
    2: { name: "sapling", label: "Sapling", len: 43, shielded: true },
    3: { name: "orchard", label: "Orchard", len: 43, shielded: true },
  };
  const isMetadata = (tc) => tc >= 0xc0 && tc <= 0xfc;
  const hexTc = (tc) => "0x" + tc.toString(16);

  /** Same checks as `zcash_address::unified` (parse_items + try_from_items_internal). */
  function validateItems(items, revision, transparentIncluding) {
    let prev = -1,
      hasData = false,
      onlyTransparent = true,
      hasTransparent = false;
    for (const it of items) {
      const tc = it.typecode,
        known = RECEIVERS[tc];
      if (isMetadata(tc)) {
        if (tc >= 0xe0) {
          if (revision === 0)
            throw new UAError(
              "metadata",
              `Required metadata ${hexTc(tc)} is not allowed in a revision 0 address.`,
            );
          if (
            (tc === 0xe0 && it.data.length !== 4) ||
            (tc === 0xe1 && it.data.length !== 8)
          )
            throw new UAError("metadata", "Malformed expiry metadata.");
          if (tc > 0xe1)
            throw new UAError(
              "metadata",
              `Unsupported required metadata ${hexTc(tc)}.`,
            );
        }
      } else if (known && it.data.length !== known.len) {
        throw new UAError(
          "receiver-length",
          `${known.label} receiver must be ${known.len} bytes, found ${it.data.length}.`,
        );
      }
      if (tc < prev)
        throw new UAError(
          "order",
          "Receivers are out of order (not a canonical encoding).",
        );
      if (tc === prev)
        throw new UAError(
          "duplicate",
          `Contains two ${known ? known.label : "items of type " + hexTc(tc)} receivers.`,
        );
      if (!isMetadata(tc)) {
        hasData = true;
        if (tc === 1 && prev === 0)
          throw new UAError(
            "p2pkh-p2sh",
            "Contains both P2PKH and P2SH transparent receivers.",
          );
        if (known && known.transparent) hasTransparent = true;
        else onlyTransparent = false;
      }
      prev = tc;
    }
    if (!hasData) throw new UAError("no-data", "Contains no receivers.");
    if (revision === 0 && onlyTransparent)
      throw new UAError(
        "only-transparent",
        "Contains only transparent receivers.",
      );
    if (revision === 2 && !transparentIncluding && hasTransparent)
      throw new UAError(
        "transparent-in-zu",
        "A shielded-only (zu) address must not contain a transparent receiver.",
      );
  }

  /** Parses the jumbled byte payload of a UA. Throws UAError. Exposed for spec vectors. */
  function parseUnifiedBytes(
    hrp,
    jumbled,
    revision,
    transparentIncluding = false,
  ) {
    if (jumbled.length < F4_MIN || jumbled.length > F4_MAX)
      throw new UAError(
        "length",
        `Encoded length (${jumbled.length} bytes) is outside the valid range.`,
      );
    const raw = f4jumble(jumbled, true),
      hb = utf8.encode(hrp);
    if (hb.length > 16) throw new UAError("hrp", "Invalid address prefix.");
    const body = raw.subarray(0, raw.length - 16),
      pad = raw.subarray(raw.length - 16);
    for (let i = 0; i < 16; i++)
      if (pad[i] !== (i < hb.length ? hb[i] : 0))
        throw new UAError(
          "padding",
          "The address is corrupted (padding check failed).",
        );
    const items = [];
    let pos = 0;
    while (pos < body.length) {
      const tc = readCompactSize(body, pos);
      const len = readCompactSize(body, tc.pos);
      if (len.pos + len.value > body.length)
        throw new UAError(
          "truncated",
          "The address is truncated (an item runs past the end).",
        );
      items.push({
        typecode: tc.value,
        data: body.slice(len.pos, len.pos + len.value),
      });
      pos = len.pos + len.value;
    }
    validateItems(items, revision, transparentIncluding);
    return items;
  }

  function summariseUnified(hrp, items) {
    const [net, revision, transparentIncluding] = UA_HRPS[hrp];
    const data = items.filter((i) => !isMetadata(i.typecode));
    const has = (n) =>
      data.some(
        (i) => RECEIVERS[i.typecode] && RECEIVERS[i.typecode].name === n,
      );
    const le = (b) => b.reduce((acc, x, i) => acc + x * 2 ** (8 * i), 0);
    const meta = (tc) => items.find((i) => i.typecode === tc);
    const hasShielded = has("orchard") || has("sapling");
    const hasTransparent = has("p2pkh") || has("p2sh");
    return {
      ok: true,
      kind: "unified",
      hrp,
      net,
      revision,
      transparentIncluding,
      items,
      receivers: data.map((i) =>
        RECEIVERS[i.typecode]
          ? RECEIVERS[i.typecode].label
          : `Unknown (${hexTc(i.typecode)})`,
      ),
      hasOrchard: has("orchard"),
      hasSapling: has("sapling"),
      hasShielded,
      hasTransparent,
      canMemo: hasShielded,
      transparentOnly: data.every(
        (i) => RECEIVERS[i.typecode] && RECEIVERS[i.typecode].transparent,
      ),
      expiryHeight: meta(0xe0) ? le(meta(0xe0).data) : null,
      expiryTime: meta(0xe1) ? le(meta(0xe1).data) * 1000 : null,
    };
  }

  const uaCache = new Map();

  /** Full ZIP 316 decode of a Unified Address string. Never throws. */
  function decodeUnified(str) {
    const key = String(str);
    if (uaCache.has(key)) return uaCache.get(key);
    let res;
    const b = bech32Decode(key);
    if (!b.ok) res = b;
    else if (!UA_HRPS[b.hrp])
      res = fail("hrp", `"${b.hrp}" is not a Unified Address prefix.`);
    else if (b.variant !== "bech32m")
      res = fail(
        "variant",
        "Unified Addresses use the Bech32m checksum; this one uses Bech32.",
      );
    else {
      const bytes = convertBits(b.words, 5, 8, false);
      if (!bytes)
        res = fail(
          "padding",
          "The address data is malformed (invalid padding).",
        );
      else {
        try {
          res = summariseUnified(
            b.hrp,
            parseUnifiedBytes(
              b.hrp,
              Uint8Array.from(bytes),
              UA_HRPS[b.hrp][1],
              UA_HRPS[b.hrp][2],
            ),
          );
        } catch (e) {
          if (e instanceof UAError) res = fail(e.code, e.message);
          else throw e;
        }
      }
    }
    if (uaCache.size > 256) uaCache.delete(uaCache.keys().next().value);
    uaCache.set(key, res);
    return res;
  }

  /** Encodes items ({typecode, data}) as a UA. Items must already be in ascending typecode order. */
  function encodeUnified(hrp, items) {
    const parts = [];
    for (const it of items)
      parts.push(
        writeCompactSize(it.typecode),
        writeCompactSize(it.data.length),
        it.data,
      );
    const pad = new Uint8Array(16);
    pad.set(utf8.encode(hrp));
    const jumbled = f4jumble(concatBytes(...parts, pad), false);
    return bech32Encode(hrp, convertBits(jumbled, 8, 5, true), "bech32m");
  }

  /* ======================= Any Zcash address ======================= */

  const SAPLING_HRPS = {
    zs: "main",
    ztestsapling: "test",
    zregtestsapling: "regtest",
  };
  const TEX_HRPS = { tex: "main", textest: "test", texregtest: "regtest" };
  const B58_PREFIXES = {
    "1cb8": ["p2pkh", "main"],
    "1cbd": ["p2sh", "main"],
    "1d25": ["p2pkh", "test"],
    "1cba": ["p2sh", "test"],
    "169a": ["sprout", "main"],
    "16b6": ["sprout", "test"],
  };
  const KIND_LABELS = {
    unified: "Unified Address",
    sapling: "Sapling address",
    p2pkh: "Transparent address (P2PKH)",
    p2sh: "Transparent address (P2SH)",
    tex: "TEX address",
    sprout: "Sprout address",
  };

  function fail(code, error, extra) {
    return Object.assign({ ok: false, code, error }, extra);
  }

  /** Identifies and fully validates any Zcash address. Never throws. */
  function classifyAddress(input) {
    const s = String(input == null ? "" : input).trim();
    if (!s) return fail("empty", "No address entered.");
    if (/\s/.test(s))
      return fail(
        "whitespace",
        "Addresses cannot contain spaces or line breaks.",
      );
    const lower = s.toLowerCase(),
      sep = lower.lastIndexOf("1"),
      hrp = sep > 0 ? lower.slice(0, sep) : "";

    if (UA_HRPS[hrp]) {
      const ua = decodeUnified(s);
      return ua.ok
        ? Object.assign({ address: lower }, ua)
        : Object.assign({ kind: "unified" }, ua);
    }
    if (SAPLING_HRPS[hrp] || TEX_HRPS[hrp]) {
      const sapling = !!SAPLING_HRPS[hrp],
        kind = sapling ? "sapling" : "tex";
      const b = bech32Decode(s);
      if (!b.ok) return Object.assign({ kind }, b);
      if (b.variant !== (sapling ? "bech32" : "bech32m"))
        return fail(
          "variant",
          `${KIND_LABELS[kind]}es use the ${sapling ? "Bech32" : "Bech32m"} checksum.`,
          { kind },
        );
      const bytes = convertBits(b.words, 5, 8, false);
      if (!bytes || bytes.length !== (sapling ? 43 : 20))
        return fail(
          "length",
          `Not a valid ${KIND_LABELS[kind]} (wrong length).`,
          { kind },
        );
      return {
        ok: true,
        kind,
        net: sapling ? SAPLING_HRPS[hrp] : TEX_HRPS[hrp],
        address: lower,
        canMemo: sapling,
        transparentOnly: !sapling,
      };
    }
    if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) {
      const p = base58CheckDecode(s);
      if (p && p.length >= 2) {
        const k = B58_PREFIXES[toHex(p.subarray(0, 2))];
        if (k && p.length === (k[0] === "sprout" ? 66 : 22)) {
          return {
            ok: true,
            kind: k[0],
            net: k[1],
            address: s,
            canMemo: k[0] === "sprout",
            transparentOnly: k[0] !== "sprout",
          };
        }
      }
      if (/^(t1|t3|tm|t2|zc|zt)/.test(s))
        return fail(
          "checksum",
          "Checksum mismatch: a character is wrong, missing or out of order.",
        );
    }
    return fail("unknown", "Not a recognised Zcash address.");
  }

  /* ============================ amounts ============================ */

  const COIN = 100000000n,
    MAX_MONEY = 21000000n * COIN;

  /** Parses a decimal ZEC string to integer zatoshis (BigInt). Zero is allowed here; callers decide. */
  function parseAmount(input) {
    const s = String(input == null ? "" : input).trim();
    if (!s) return fail("empty", "Amount is required.");
    const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m)
      return fail(
        "format",
        "Use digits with an optional decimal point, e.g. 0.25.",
      );
    if (m[2] && m[2].length > 8)
      return fail("precision", "ZEC has at most 8 decimal places.");
    const zats = BigInt(m[1]) * COIN + BigInt((m[2] || "").padEnd(8, "0"));
    if (zats > MAX_MONEY)
      return fail("max", "Amount exceeds the 21,000,000 ZEC supply.");
    return { ok: true, zats };
  }

  /** Canonical ZIP-321 amount string, identical to librustzcash `render::amount_str`. */
  function formatAmount(zats) {
    const z = BigInt(zats),
      coins = z / COIN,
      frac = z % COIN;
    return frac === 0n
      ? String(coins)
      : `${coins}.${String(frac).padStart(8, "0")}`.replace(/0+$/, "");
  }

  /* ============================== memos ============================== */

  const MEMO_MAX = 512;

  function base64UrlEncode(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /** Strict URL-safe, unpadded Base64 decode (rejects padding and non-canonical trailing bits). */
  function base64UrlDecode(s) {
    if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
    let bin;
    try {
      bin = atob(
        s.replace(/-/g, "+").replace(/_/g, "/") +
          "=".repeat((4 - (s.length % 4)) % 4),
      );
    } catch (e) {
      return null;
    }
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return base64UrlEncode(bytes) === s ? bytes : null;
  }

  /** UTF-8 text memo. Returns { ok, bytes, length, b64 } or an error when over 512 bytes. */
  function encodeMemo(text) {
    const bytes = utf8.encode(String(text == null ? "" : text));
    if (bytes.length > MEMO_MAX)
      return fail(
        "memo-size",
        `Memo is ${bytes.length} bytes; the limit is ${MEMO_MAX} bytes. Shorten it by ${bytes.length - MEMO_MAX}.`,
        { length: bytes.length },
      );
    return {
      ok: true,
      bytes,
      length: bytes.length,
      b64: base64UrlEncode(bytes),
    };
  }

  /** Decodes a ZIP-321 memo parameter. `text` is set when it is a ZIP 302 text memo. */
  function decodeMemo(b64) {
    const bytes = base64UrlDecode(b64);
    if (!bytes)
      return fail("memo-base64", "Memo is not valid unpadded Base64URL.");
    if (bytes.length > MEMO_MAX)
      return fail(
        "memo-size",
        `Memo is ${bytes.length} bytes; the limit is ${MEMO_MAX}.`,
      );
    let text = null;
    if (!bytes.length || bytes[0] <= 0xf4) {
      try {
        text = utf8Strict.decode(bytes.subarray(0, trimZeros(bytes)));
      } catch (e) {
        text = null;
      }
    }
    return { ok: true, bytes, text };
  }
  function trimZeros(b) {
    let n = b.length;
    while (n && b[n - 1] === 0) n--;
    return n;
  }

  /* ============================== ZIP-321 ============================== */

  /** Percent-encodes everything outside `qchar` (same set as librustzcash `render::QCHAR_ENCODE`). */
  function qchar(str) {
    let out = "";
    for (const b of utf8.encode(String(str))) {
      const c = String.fromCharCode(b);
      out +=
        b < 0x80 && /[A-Za-z0-9\-._~!$'()*+,;:@]/.test(c)
          ? c
          : "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
    return out;
  }

  /** Percent-decodes then strictly decodes UTF-8 (throws on invalid UTF-8), like `percent_decode().decode_utf8()`. */
  function pctDecode(s) {
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
        bytes.push(parseInt(s.substr(i + 1, 2), 16));
        i += 2;
      } else bytes.push(s.charCodeAt(i));
    }
    return utf8Strict.decode(Uint8Array.from(bytes));
  }

  /**
   * Renders payments as a ZIP-321 URI, byte-for-byte like `TransactionRequest::to_uri`.
   * payment: { address, zats?: BigInt, memo?: Uint8Array, label?: string, message?: string, other?: [[name, value]] }
   * Addresses must already be validated.
   */
  function renderRequest(payments) {
    if (!payments.length) return "zcash:";
    const params = (p, i) => {
      const sfx = i ? "." + i : "",
        q = [];
      if (p.zats != null) q.push(`amount${sfx}=${formatAmount(p.zats)}`);
      if (p.memo != null) q.push(`memo${sfx}=${base64UrlEncode(p.memo)}`);
      if (p.label != null) q.push(`label${sfx}=${qchar(p.label)}`);
      if (p.message != null) q.push(`message${sfx}=${qchar(p.message)}`);
      for (const [k, v] of p.other || []) q.push(`${k}${sfx}=${qchar(v)}`);
      return q;
    };
    if (payments.length === 1) {
      const q = params(payments[0], 0);
      return (
        "zcash:" + payments[0].address + (q.length ? "?" + q.join("&") : "")
      );
    }
    return (
      "zcash:?" +
      payments
        .flatMap((p, i) =>
          [`address${i ? "." + i : ""}=${p.address}`].concat(params(p, i)),
        )
        .join("&")
    );
  }

  const PARAM_RE =
    /^([A-Za-z][A-Za-z0-9+-]*)(?:\.([1-9][0-9]{0,3}))?=([A-Za-z0-9\-._~!$'()*+,;:@%]*)$/;

  /**
   * Parses a ZIP-321 URI with the rules of `TransactionRequest::from_uri`.
   * Returns { ok, payments: [{ index, address, info, zats, memo, label, message, other }], total }.
   */
  function parseRequest(uri) {
    const s = String(uri == null ? "" : uri).trim();
    if (!/^zcash:/i.test(s))
      return fail("scheme", 'A payment request starts with "zcash:".');
    const rest = s.slice(6),
      qi = rest.indexOf("?");
    const lead = qi < 0 ? rest : rest.slice(0, qi),
      query = qi < 0 ? "" : rest.slice(qi + 1);
    const byIndex = new Map();
    const slot = (i) => {
      if (!byIndex.has(i)) byIndex.set(i, { index: i, other: [] });
      return byIndex.get(i);
    };

    if (lead) {
      const a = classifyAddress(lead);
      if (!a.ok)
        return fail("address", `Payment address: ${a.error}`, { index: 0 });
      Object.assign(slot(0), { address: a.address, info: a });
    }
    if (query) {
      for (const part of query.split("&")) {
        const m = PARAM_RE.exec(part);
        if (!m)
          return fail("syntax", `Malformed parameter "${part.slice(0, 40)}".`);
        const [, name, idxStr, value] = m,
          index = idxStr ? +idxStr : 0,
          p = slot(index);
        const label = index ? `${name}.${index}` : name;
        const once = (key) => {
          if (p[key] !== undefined)
            throw fail("duplicate", `Parameter "${label}" appears twice.`);
        };
        try {
          if (name === "address") {
            once("address");
            const a = classifyAddress(value);
            if (!a.ok)
              return fail("address", `${label}: ${a.error}`, { index });
            p.address = a.address;
            p.info = a;
          } else if (name === "amount") {
            once("zats");
            const r = parseAmount(value);
            if (!r.ok) return fail("amount", `${label}: ${r.error}`, { index });
            p.zats = r.zats;
          } else if (name === "memo") {
            once("memo");
            const r = decodeMemo(value);
            if (!r.ok) return fail(r.code, `${label}: ${r.error}`, { index });
            p.memo = r;
          } else if (name === "label" || name === "message") {
            once(name);
            p[name] = pctDecode(value);
          } else if (name.startsWith("req-")) {
            return fail(
              "required",
              `Unsupported required parameter "${name}"; wallets must refuse this request.`,
            );
          } else {
            if (p.other.some(([n]) => n === name))
              throw fail("duplicate", `Parameter "${label}" appears twice.`);
            p.other.push([name, pctDecode(value)]);
          }
        } catch (e) {
          if (e && e.ok === false) return e;
          return fail("encoding", `${label}: not valid percent-encoded UTF-8.`);
        }
      }
    }
    const payments = [...byIndex.values()].sort((a, b) => a.index - b.index);
    let total = 0n;
    for (const p of payments) {
      const where = p.index ? `Payment ${p.index}` : "The first payment";
      if (!p.address)
        return fail("missing-address", `${where} has no address.`, {
          index: p.index,
        });
      if (p.info.kind === "sprout")
        return fail(
          "sprout",
          `${where} is to a Sprout address, which is no longer supported.`,
          { index: p.index },
        );
      if (p.memo && !p.info.canMemo)
        return fail(
          "transparent-memo",
          `${where} attaches a memo to a transparent address, which cannot receive memos.`,
          { index: p.index },
        );
      if (p.zats === 0n && p.info.transparentOnly)
        return fail(
          "zero-transparent",
          `${where} requests a zero-value transparent output.`,
          { index: p.index },
        );
      if (p.zats != null) total += p.zats;
    }
    return {
      ok: true,
      payments,
      total: payments.every((p) => p.zats != null) ? total : null,
    };
  }

  /* ============================ merchant helpers ============================ */

  const NETS = {
    main: { id: "main", coin: "ZEC", name: "Mainnet", uaPrefix: "u1" },
    test: { id: "test", coin: "TAZ", name: "Testnet", uaPrefix: "utest1" },
  };
  const KIND_POLICY = {
    sapling:
      "This is a Sapling address (zs…). Zectill accepts Unified Addresses only: copy the Unified Address from your wallet's Receive screen.",
    p2pkh:
      "This is a transparent address (t…), so payments to it would be public. Use your wallet's shielded Unified Address.",
    p2sh: "This is a transparent address (t…), so payments to it would be public. Use your wallet's shielded Unified Address.",
    tex: "This is a TEX address, which only accepts transparent funds. Use a Unified Address.",
    sprout:
      "Sprout addresses are deprecated and can no longer receive payments.",
  };

  /** Merchant policy: a fully valid Unified Address on `net` with at least one shielded receiver. */
  function checkPayTo(input, net, now = Date.now()) {
    const a = classifyAddress(input);
    if (!a.ok) return a;
    if (a.kind !== "unified")
      return fail("kind", KIND_POLICY[a.kind], { info: a });
    if (a.net !== net) {
      const other = NETS[a.net];
      return fail(
        "network",
        other
          ? `This is a ${other.name.toLowerCase()} address. Switch to ${other.name}, or paste a ${NETS[net].name.toLowerCase()} address.`
          : "This is a regtest address.",
        { info: a, mismatch: true, detected: a.net },
      );
    }
    if (!a.hasShielded)
      return fail(
        "no-shielded",
        "This Unified Address has no Sapling or Orchard receiver, so payments to it would not be shielded.",
        { info: a },
      );
    if (a.expiryTime && a.expiryTime <= now)
      return fail(
        "expired",
        `This address expired on ${new Date(a.expiryTime).toISOString().slice(0, 10)}. Generate a fresh one in your wallet.`,
        { info: a },
      );
    return { ok: true, value: a.address, info: a };
  }

  /* Demo receivers carry a deliberately non-canonical key encoding (x ≥ field modulus), so
     every encoding check passes but wallets refuse to pay them: no funds can be lost. */
  const DEMO_KEY = Uint8Array.from({ length: 32 }, (_, i) =>
    i === 31 ? 0x7f : 0xff,
  );
  function demoAddress(net, seed = 0) {
    const d = (salt) =>
      Uint8Array.from(
        { length: 11 },
        (_, i) => (seed * 37 + i * 11 + salt) & 0xff,
      );
    const hrp = net === "test" ? "utest" : "u";
    return encodeUnified(hrp, [
      { typecode: 2, data: concatBytes(d(0x5a), DEMO_KEY) },
      { typecode: 3, data: concatBytes(d(0xa5), DEMO_KEY) },
    ]);
  }
  function isDemoAddress(info) {
    return !!(
      info &&
      info.items &&
      info.items.some(
        (i) =>
          i.data.length === 43 &&
          toHex(i.data.subarray(11)) === toHex(DEMO_KEY),
      )
    );
  }

  function splitDelimited(line, delim) {
    const out = [];
    let cur = "",
      quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"' && !cur.trim()) {
        quoted = true;
        cur = "";
      } else if (c === delim) {
        out.push(cur.trim());
        cur = "";
      } else cur += c;
    }
    out.push(cur.trim());
    return out;
  }

  /**
   * Parses one entry per line. columns: [{ key, type: 'address'|'amount'|'memo'|'name', label, optional }].
   * Accepts comma, semicolon or tab separated values (quotes allowed), or whitespace separated values.
   * Blank lines, # comments and a header row are skipped. Valid lines are kept even when others fail.
   */
  function parseEntries(text, net, columns) {
    const rows = [],
      issues = [],
      required = columns.filter((c) => !c.optional).length,
      max = columns.length;
    const describe = columns
      .map((c) =>
        c.optional ? `[${c.label.toLowerCase()}]` : c.label.toLowerCase(),
      )
      .join(", ");
    let first = true;
    String(text || "")
      .split(/\r\n|\n|\r/)
      .forEach((raw, i) => {
        const line = raw.trim(),
          lineNo = i + 1;
        if (!line || line[0] === "#") return;
        const delim = line.includes("\t")
          ? "\t"
          : line.includes(",")
            ? ","
            : line.includes(";")
              ? ";"
              : null;
        let f = delim ? splitDelimited(line, delim) : line.split(/\s+/);
        if (!delim && f.length > max && columns[max - 1].optional)
          f = f.slice(0, max - 1).concat(f.slice(max - 1).join(" "));
        const amountAt = columns.findIndex((c) => c.type === "amount");
        if (first) {
          first = false;
          if (
            f[amountAt] !== undefined &&
            !parseAmount(f[amountAt]).ok &&
            f.some((x) =>
              /^(address|recipient|payer|name|amount|memo|to|from|who|wallet)\b/i.test(
                x,
              ),
            )
          )
            return;
        }
        while (f.length > required && f[f.length - 1] === "") f.pop();
        if (f.length < required || f.length > max) {
          issues.push({
            line: lineNo,
            level: "error",
            message: `Expected ${describe}; found ${f.length} value${f.length === 1 ? "" : "s"}.`,
          });
          return;
        }
        const row = { line: lineNo };
        for (let k = 0; k < f.length; k++) {
          const col = columns[k],
            v = f[k];
          const bad = (msg) =>
            issues.push({
              line: lineNo,
              level: "error",
              message: `${col.label}: ${msg}`,
            });
          if (col.type === "address") {
            const r = checkPayTo(v, net);
            if (!r.ok) return bad(r.error);
            row[col.key] = r.value;
            row[col.key + "Info"] = r.info;
          } else if (col.type === "amount") {
            const r = parseAmount(v.replace(/\s*(zec|taz)$/i, ""));
            if (!r.ok) return bad(r.error);
            if (r.zats === 0n) return bad("must be greater than zero.");
            row[col.key] = r.zats;
          } else if (col.type === "memo") {
            if (v) {
              const e = encodeMemo(v);
              if (!e.ok) return bad(e.error);
              row[col.key] = v;
            }
          } else if (col.type === "name") {
            if (!v) return bad("is empty.");
            if (v.length > 40) return bad("keep names to 40 characters.");
            row[col.key] = v;
          }
        }
        rows.push(row);
      });
    const seen = new Map();
    for (const r of rows)
      for (const c of columns) {
        if (c.type !== "address" || !r[c.key]) continue;
        const k = c.key + ":" + r[c.key];
        if (seen.has(k))
          issues.push({
            line: r.line,
            level: "warning",
            message: `${c.label} also appears on line ${seen.get(k)}. Intentional?`,
          });
        else seen.set(k, r.line);
      }
    issues.sort((a, b) => a.line - b.line);
    return { rows, issues };
  }

  /* Batch modes. A ZIP-321 request is one transaction from one payer, so only a payout
     fits in a single request; bill splits and settlements need one request per payer. */
  const BATCH_COLUMNS = {
    "one-many": [
      { key: "address", type: "address", label: "Recipient" },
      { key: "amount", type: "amount", label: "Amount" },
      { key: "memo", type: "memo", label: "Memo", optional: true },
    ],
    "many-one": [
      { key: "payer", type: "name", label: "Name" },
      { key: "amount", type: "amount", label: "Amount" },
    ],
    "many-many": [
      { key: "payer", type: "name", label: "Payer" },
      { key: "address", type: "address", label: "Recipient" },
      { key: "amount", type: "amount", label: "Amount" },
    ],
  };

  /**
   * Builds the payment requests for parsed batch rows.
   * one-many: one multi-recipient request, each row's memo attached to its own payment.
   * many-one / many-many: one request per row, to `merchant` or the row's recipient, with the
   * memo "<reference> · <payer name>" so the recipient's wallet shows who paid.
   * Returns { requests: [{ uri, zats, payer?, to?, memo?, line? }], issues }.
   */
  function buildBatch(mode, rows, opts = {}) {
    const requests = [],
      issues = [];
    if (!rows.length) return { requests, issues };
    if (mode === "one-many") {
      const payments = rows.map((r) => ({
        address: r.address,
        zats: r.amount,
        memo: r.memo ? encodeMemo(r.memo).bytes : null,
      }));
      requests.push({
        uri: renderRequest(payments),
        zats: rows.reduce((s, r) => s + r.amount, 0n),
        count: rows.length,
      });
      return { requests, issues };
    }
    const ref = String(opts.ref || "").trim();
    for (const r of rows) {
      const to = mode === "many-one" ? opts.merchant : r.address;
      if (!to) break;
      const memoText = [ref, r.payer].filter(Boolean).join(" · ");
      const memo = encodeMemo(memoText);
      if (!memo.ok) {
        issues.push({ line: r.line, level: "error", message: memo.error });
        continue;
      }
      requests.push({
        uri: renderRequest([{ address: to, zats: r.amount, memo: memo.bytes }]),
        zats: r.amount,
        payer: r.payer,
        to,
        memo: memoText,
        line: r.line,
      });
    }
    return { requests, issues };
  }

  /* Unique amounts: a small per-invoice tag (1–999 zatoshis, a fraction of a cent) derived
     from the invoice ID. The tag makes the exact amount identify the invoice, so a payment
     can still be matched when the paying wallet drops or edits the memo. A price that already
     uses the last three decimal places is left untagged: it is just as distinctive. */
  const TAG_SPAN = 1000n;
  function amountTag(id) {
    const h = sha256(utf8.encode(String(id)));
    return BigInt(((h[0] << 8) | h[1]) % 999) + 1n;
  }
  const hasTag = (zats) => BigInt(zats) % TAG_SPAN !== 0n;

  /* Decodes long hex runs (e.g. zcashd memo fields) so invoice IDs inside them can be found. */
  function hexText(line) {
    const out = [];
    for (const m of line.matchAll(/\b(?:[0-9a-f]{2}){8,}\b/gi)) {
      if (m[0].length === 64) continue;
      const b = fromHex(m[0]),
        n = trimZeros(b);
      if (!n || b[0] > 0xf4) continue;
      try {
        out.push(utf8Strict.decode(b.subarray(0, n)));
      } catch (e) {
        /* not text */
      }
    }
    return out.join(" ");
  }
  const AMOUNT_RE =
    /(?:^|[\s,;:"'=(\[])(\d{1,8}(?:\.\d{1,8})?)(?=$|[\s,;"')\]]|\s*(?:ZEC|TAZ)\b)/gi;
  const TXID_RE = /\b[0-9a-f]{64}\b/i;

  /**
   * Matches pasted wallet history (CSV export, memo text or zcashd JSON) to invoices.
   * invoices: [{ id, zats: BigInt, status }]. A line matches when it contains an invoice ID;
   * an amount equal to the amount due is preferred, otherwise the first decimal number is used.
   * A line with no ID still matches when its amount is not round (tagged, see amountTag, or
   * precise to the zatoshi) and belongs to exactly one open invoice. Each match reports `via: "memo" | "amount"`.
   */
  function reconcile(text, invoices) {
    const byId = new Map(invoices.map((inv) => [inv.id.toUpperCase(), inv]));
    if (!byId.size) return { matches: [], scanned: 0 };
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const idRe = new RegExp(
      "(?:^|[^A-Z0-9-])(" +
        [...byId.keys()]
          .sort((a, b) => b.length - a.length)
          .map(esc)
          .join("|") +
        ")(?=$|[^A-Z0-9-])",
      "g",
    );
    /* Tagged amounts that belong to exactly one open invoice, for lines without an ID. */
    const tagged = new Map();
    for (const inv of invoices) {
      if (inv.status !== "pending" || !hasTag(inv.zats)) continue;
      const k = String(inv.zats);
      tagged.set(k, tagged.has(k) ? null : inv);
    }
    const agg = new Map();
    let scanned = 0;
    String(text || "")
      .split(/\r\n|\n|\r/)
      .forEach((line, i) => {
        if (!line.trim()) return;
        scanned++;
        const hay = (line + " " + hexText(line)).toUpperCase(),
          ids = new Set();
        for (const m of hay.matchAll(idRe)) ids.add(m[1]);
        const txid = (line.match(TXID_RE) || [])[0] || null;
        const nums = [...line.matchAll(AMOUNT_RE)].map((m) => m[1]);
        let byAmount = false;
        if (!ids.size) {
          const hit = nums
            .map((n) => parseAmount(n))
            .filter((r) => r.ok)
            .map((r) => tagged.get(String(r.zats)))
            .find(Boolean);
          if (!hit) return;
          ids.add(hit.id.toUpperCase());
          byAmount = true;
        }
        ids.forEach((id) => {
          const inv = byId.get(id),
            due = BigInt(inv.zats);
          const a = agg.get(id) || {
            inv,
            lines: [],
            keys: new Set(),
            sum: 0n,
            found: false,
            byMemo: false,
          };
          a.lines.push(i + 1);
          if (!byAmount) a.byMemo = true;
          const key = txid ? txid.toLowerCase() : "line" + i;
          if (!a.keys.has(key)) {
            a.keys.add(key);
            const parsed = nums
              .map((n) => ({ n, r: parseAmount(n) }))
              .filter((x) => x.r.ok);
            const exact = parsed.find((x) => x.r.zats === due),
              dec = parsed.find((x) => x.n.includes("."));
            const pick = exact || dec;
            if (pick) {
              a.sum += pick.r.zats;
              a.found = true;
            }
          }
          agg.set(id, a);
        });
      });
    const matches = [...agg.values()].map((a) => {
      const due = BigInt(a.inv.zats);
      const verdict =
        a.inv.status === "void"
          ? "void"
          : a.inv.status === "paid"
            ? "already-paid"
            : !a.found
              ? "check"
              : a.sum >= due
                ? "paid"
                : "partial";
      return {
        id: a.inv.id,
        lines: a.lines,
        txids: [...a.keys].filter((k) => !k.startsWith("line")),
        found: a.found ? a.sum : null,
        due,
        verdict,
        via: a.byMemo ? "memo" : "amount",
      };
    });
    return { matches, scanned };
  }

  return {
    version: "2.0.0",
    bytes: { toHex, fromHex, concat: concatBytes },
    hash: { blake2b, sha256 },
    bech32: { decode: bech32Decode, encode: bech32Encode, convertBits },
    base58: { decode: base58Decode, checkDecode: base58CheckDecode },
    f4jumble: (m) => f4jumble(m, false),
    f4jumbleInv: (m) => f4jumble(m, true),
    ua: {
      decode: decodeUnified,
      encode: encodeUnified,
      parseBytes: parseUnifiedBytes,
      RECEIVERS,
      UAError,
    },
    classifyAddress,
    KIND_LABELS,
    COIN,
    MAX_MONEY,
    parseAmount,
    formatAmount,
    MEMO_MAX,
    encodeMemo,
    decodeMemo,
    base64url: { encode: base64UrlEncode, decode: base64UrlDecode },
    zip321: { render: renderRequest, parse: parseRequest, qchar },
    NETS,
    checkPayTo,
    demoAddress,
    isDemoAddress,
    parseEntries,
    splitDelimited,
    BATCH_COLUMNS,
    buildBatch,
    amountTag,
    hasTag,
    reconcile,
  };
});
