/* Zectill spec test suite. Runs the shipped engine (assets/zcash.js) against official vectors from
   zcash/librustzcash, BIP 350, RFC 7693 and FIPS 180-4, then renders the wallet compatibility kit.
   Headless check: the document title becomes "PASS n/n" or "FAIL k/n". */
(function () {
  "use strict";
  const Z = window.ZcashKit;
  const { toHex, fromHex } = Z.bytes;
  const enc = (s) => new TextEncoder().encode(s);
  const groups = [];
  let group = null;

  function section(name, source) {
    group = { name, source, results: [] };
    groups.push(group);
  }
  function t(name, fn) {
    let ok = false,
      detail = "";
    try {
      const r = fn();
      ok = r === true;
      if (!ok && r !== false) detail = String(r);
    } catch (e) {
      detail = "threw: " + (e && e.message);
    }
    group.results.push({ name, ok, detail });
  }
  const eq = (a, b) => a === b || `expected ${b}, got ${a}`;
  const errCode = (r, code) =>
    (!r.ok && r.code === code) ||
    `expected error "${code}", got ${r.ok ? "ok" : r.code + ": " + r.error}`;

  /* --------------------------------------------------------------- hashes */
  section("Hash functions", "RFC 7693 Appendix A, FIPS 180-4 examples");
  t('BLAKE2b-512("")', () =>
    eq(
      toHex(Z.hash.blake2b(new Uint8Array(0))),
      "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
    ),
  );
  t('BLAKE2b-512("abc")', () =>
    eq(
      toHex(Z.hash.blake2b(enc("abc"))),
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    ),
  );
  t('SHA-256("")', () =>
    eq(
      toHex(Z.hash.sha256(new Uint8Array(0))),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ),
  );
  t('SHA-256("abc")', () =>
    eq(
      toHex(Z.hash.sha256(enc("abc"))),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    ),
  );
  t("SHA-256 two-block message", () =>
    eq(
      toHex(
        Z.hash.sha256(
          enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        ),
      ),
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ),
  );

  /* --------------------------------------------------------------- bech32 */
  section("Bech32 / Bech32m", "BIP 173 and BIP 350 test vectors");
  for (const s of [
    "A1LQFN3A",
    "a1lqfn3a",
    "abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx",
    "?1v759aa",
  ]) {
    t(`Bech32m valid: ${s}`, () => eq(Z.bech32.decode(s).variant, "bech32m"));
  }
  t("Bech32 valid: A12UEL5L", () =>
    eq(Z.bech32.decode("A12UEL5L").variant, "bech32"),
  );
  t("Bech32m rejects a bad checksum", () =>
    errCode(
      Z.bech32.decode("abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryy"),
      "checksum",
    ),
  );
  t("Bech32m rejects mixed case", () =>
    errCode(Z.bech32.decode("A1lqfn3a"), "mixed-case"),
  );
  t(
    "No 90-character limit (ZIP 316)",
    () =>
      Z.bech32.decode(window.ZECTILL_UA_VECTORS[59].unified_addr).ok ||
      "long UA rejected",
  );

  /* --------------------------------------------------------------- F4Jumble */
  section(
    "F4Jumble",
    "ZIP 316 §Jumbling; round trips at every branch of the length rules",
  );
  for (const n of [48, 64, 127, 128, 200, 1000]) {
    t(`F4Jumble⁻¹(F4Jumble(x)) = x for ${n} bytes`, () => {
      const x = Uint8Array.from({ length: n }, (_, i) => (i * 131 + 7) & 0xff);
      const j = Z.f4jumble(x);
      return toHex(Z.f4jumbleInv(j)) === toHex(x) && toHex(j) !== toHex(x);
    });
  }
  t("Rejects inputs shorter than 48 bytes", () => {
    try {
      Z.f4jumble(new Uint8Array(47));
      return false;
    } catch (e) {
      return e instanceof RangeError;
    }
  });

  /* --------------------------------------------------------------- official UA vectors */
  section(
    "Unified Addresses: official vectors",
    "librustzcash zcash_address unified/address/test_vectors.rs (60 vectors)",
  );
  const V = window.ZECTILL_UA_VECTORS || [];
  t("Vector file loaded (60 vectors)", () => eq(V.length, 60));
  V.forEach((v, n) => {
    t(`Vector ${n + 1}: decodes and re-encodes identically`, () => {
      const r = Z.ua.decode(v.unified_addr);
      if (!r.ok) return r.error;
      const want = [
        [0, v.p2pkh_bytes],
        [1, v.p2sh_bytes],
        [2, v.sapling_raw_addr],
        [3, v.orchard_raw_addr],
        [v.unknown_typecode, v.unknown_bytes],
      ]
        .filter(([tc, b]) => tc != null && b != null)
        .sort((a, b) => a[0] - b[0]);
      const got = r.items.map((i) => [i.typecode, toHex(i.data)]);
      if (JSON.stringify(got) !== JSON.stringify(want))
        return "receivers differ";
      if (r.net !== "main" || r.revision !== 0)
        return "wrong network or revision";
      return eq(Z.ua.encode("u", r.items), v.unified_addr);
    });
  });

  /* --------------------------------------------------------------- UA negative cases */
  section(
    "Unified Addresses: invalid encodings",
    "librustzcash unified/address.rs tests + constructed cases",
  );
  const raw = (hex) => fromHex(hex.replace(/\s|0x|,/g, ""));
  const parseRaw = (bytes) => {
    try {
      Z.ua.parseBytes("u", bytes, 0);
      return { ok: true };
    } catch (e) {
      return { ok: false, code: e.code, error: e.message };
    }
  };
  t("Invalid padding bytes rejected", () =>
    errCode(
      parseRaw(
        raw(
          "e659d1edf74be35e5a540e415d2f0c0d3342bdbe9f826201c11bd41e424786 23054b98d77686a5e31bd303ca24448e72c14ac6bf3f2bcea77b2869c984",
        ),
      ),
      "padding",
    ),
  );
  t("Truncated (15-byte) padding rejected", () =>
    errCode(
      parseRaw(
        raw(
          "9a5612a34345e0826cac248b3b45729a53d5f8daec077cba9fa8d2975bda731bd2d1326b7b36dd57842aa021238973 85e14b3e95b7d467bc4b31ee5a",
        ),
      ),
      "padding",
    ),
  );
  t(
    "Truncated Sapling receiver rejected",
    () =>
      !parseRaw(
        raw(
          "aab06e7b267a221739fa0769e9322bac8c9e5e8ad924065a13793a8db452fa184e334d8c17774d63693422703aea30825a6b37d10dbe20ab828698346ad84540d02560bf1eb6eb0685704c42bc1914ef7a05a071b26380bbdc120848288f1c9ec342c65e68a2786c9e",
        ),
      ).ok,
  );
  t(
    "Truncated after a typecode rejected",
    () =>
      !parseRaw(
        raw(
          "877adf796be3b340efe45dc291a281fc7d76bbb058985359d33fbc4b8659666275 92bacc311e60023bd84cdf36a1ac8257ed0c98498f497ee670365b7b9e",
        ),
      ).ok,
  );
  t(
    "Transparent-only payload rejected",
    () =>
      !parseRaw(
        raw(
          "f09e9d6ef5a6ac1650f0dbe12ca53622a2048986e96a9bf3ff6d2fe6eadbc52062f96fa986cc",
        ),
      ).ok,
  );
  const r43 = (b) => new Uint8Array(43).fill(b),
    r20 = (b) => new Uint8Array(20).fill(b);
  t("Duplicate typecode rejected", () =>
    errCode(
      Z.ua.decode(
        Z.ua.encode("u", [
          { typecode: 2, data: r43(1) },
          { typecode: 2, data: r43(2) },
        ]),
      ),
      "duplicate",
    ),
  );
  t("P2PKH + P2SH together rejected", () =>
    errCode(
      Z.ua.decode(
        Z.ua.encode("u", [
          { typecode: 0, data: r20(0) },
          { typecode: 1, data: r20(0) },
          { typecode: 3, data: r43(0) },
        ]),
      ),
      "p2pkh-p2sh",
    ),
  );
  t("Out-of-order receivers rejected", () =>
    errCode(
      Z.ua.decode(
        Z.ua.encode("u", [
          { typecode: 2, data: r43(0) },
          { typecode: 0, data: r20(0) },
        ]),
      ),
      "order",
    ),
  );
  t("Wrong receiver length rejected", () =>
    errCode(
      Z.ua.decode(
        Z.ua.encode("u", [
          { typecode: 3, data: new Uint8Array(42) },
          { typecode: 0x7f, data: new Uint8Array(8) },
        ]),
      ),
      "receiver-length",
    ),
  );
  t("Revision 0 rejects required metadata", () =>
    errCode(
      Z.ua.decode(
        Z.ua.encode("u", [
          { typecode: 3, data: r43(0) },
          { typecode: 0xe0, data: new Uint8Array(4) },
        ]),
      ),
      "metadata",
    ),
  );
  t("zu (shielded-only) rejects a transparent receiver", () =>
    errCode(
      Z.ua.decode(
        Z.ua.encode("zu", [
          { typecode: 0, data: r20(0) },
          { typecode: 3, data: r43(0) },
        ]),
      ),
      "transparent-in-zu",
    ),
  );
  t("tu (revision 2) accepts transparent + Orchard", () => {
    const r = Z.ua.decode(
      Z.ua.encode("tu", [
        { typecode: 0, data: r20(0) },
        { typecode: 3, data: r43(0) },
      ]),
    );
    return (r.ok && r.revision === 2) || r.error;
  });
  t("Expiry time metadata decoded (revision 2)", () => {
    const exp = new Uint8Array(8);
    new DataView(exp.buffer).setUint32(0, 1700000000, true);
    const r = Z.ua.decode(
      Z.ua.encode("zu", [
        { typecode: 3, data: r43(0) },
        { typecode: 0xe1, data: exp },
      ]),
    );
    return (r.ok && r.expiryTime === 1700000000000) || r.error;
  });
  const good = V[0] ? V[0].unified_addr : "";
  t("Single-character typo rejected", () =>
    errCode(
      Z.ua.decode(
        good.slice(0, 40) + (good[40] === "q" ? "p" : "q") + good.slice(41),
      ),
      "checksum",
    ),
  );
  t("Swapped adjacent characters rejected", () =>
    errCode(
      Z.ua.decode(good.slice(0, 30) + good[31] + good[30] + good.slice(32)),
      "checksum",
    ),
  );
  t("Truncated address rejected", () => !Z.ua.decode(good.slice(0, -3)).ok);
  t("Upper-case form accepted", () => Z.ua.decode(good.toUpperCase()).ok);
  t("Mixed case rejected", () =>
    errCode(
      Z.ua.decode(good.slice(0, 20).toUpperCase() + good.slice(20)),
      "mixed-case",
    ),
  );

  /* --------------------------------------------------------------- address kinds */
  section(
    "Address classification",
    "librustzcash zcash_address encoding.rs vectors",
  );
  const kinds = [
    [
      "zc8E5gYid86n4bo2Usdq1cpr7PpfoJGzttwBHEEgGhGkLUg7SPPVFNB2AkRFXZ7usfphup5426dt1buMmY3fkYeRrQGLa8y",
      "sprout",
      "main",
    ],
    [
      "ztJ1EWLKcGwF2S4NA17pAJVdco8Sdkz4AQPxt1cLTEfNuyNswJJc2BbBqYrsRZsp31xbVZwhF7c7a2L9jsF3p3ZwRWpqqyS",
      "sprout",
      "test",
    ],
    [
      "zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpq6d8g",
      "sapling",
      "main",
    ],
    [
      "ztestsapling1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqfhgwqu",
      "sapling",
      "test",
    ],
    [
      "zregtestsapling1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqknpr3m",
      "sapling",
      "regtest",
    ],
    [
      "u1qpatys4zruk99pg59gcscrt7y6akvl9vrhcfyhm9yxvxz7h87q6n8cgrzzpe9zru68uq39uhmlpp5uefxu0su5uqyqfe5zp3tycn0ecl",
      "unified",
      "main",
    ],
    [
      "utest10c5kutapazdnf8ztl3pu43nkfsjx89fy3uuff8tsmxm6s86j37pe7uz94z5jhkl49pqe8yz75rlsaygexk6jpaxwx0esjr8wm5ut7d5s",
      "unified",
      "test",
    ],
    [
      "uregtest15xk7vj4grjkay6mnfl93dhsflc2yeunhxwdh38rul0rq3dfhzzxgm5szjuvtqdha4t4p2q02ks0jgzrhjkrav70z9xlvq0plpcjkd5z3",
      "unified",
      "regtest",
    ],
    ["t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs", "p2pkh", "main"],
    ["tm9iMLAuYMzJ6jtFLcA7rzUmfreGuKvr7Ma", "p2pkh", "test"],
    ["t3JZcvsuaXE6ygokL4XUiZSTrQBUoPYFnXJ", "p2sh", "main"],
    ["t26YoyZ1iPgiMEWL4zGUm74eVWfhyDMXzY2", "p2sh", "test"],
    ["tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte", "tex", "main"],
    ["textest1qyqszqgpqyqszqgpqyqszqgpqyqszqgpfcjgfy", "tex", "test"],
  ];
  for (const [a, kind, net] of kinds)
    t(`${kind} / ${net}: ${a.slice(0, 18)}…`, () => {
      const r = Z.classifyAddress(a);
      return (
        (r.ok && r.kind === kind && r.net === net) ||
        r.error ||
        `${r.kind}/${r.net}`
      );
    });
  t(
    '"uinvalid1…" is not a Zcash address',
    () =>
      !Z.classifyAddress(
        "uinvalid1ck5navqwcng43gvsxwrxsplc22p7uzlcag6qfa0zh09e87efq6rq8wsnv25umqjjravw70rl994n5ueuhza2fghge5gl7zrl2qp6cwmp",
      ).ok,
  );
  t("Transparent checksum typo rejected", () =>
    errCode(
      Z.classifyAddress("t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbt"),
      "checksum",
    ),
  );

  /* --------------------------------------------------------------- amounts */
  section(
    "Amounts",
    "librustzcash zip321 render::amount_str / parse::parse_amount",
  );
  const amt = (s) => Z.parseAmount(s);
  t("0.1 → 10,000,000 zatoshis", () => amt("0.1").zats === 10000000n);
  t(
    "Canonical rendering trims zeros (0.10 → 0.1, 1.00 → 1)",
    () =>
      Z.formatAmount(amt("0.10").zats) === "0.1" &&
      Z.formatAmount(amt("1.00").zats) === "1",
  );
  t("1 zatoshi renders as 0.00000001", () =>
    eq(Z.formatAmount(1n), "0.00000001"),
  );
  t("0.1 + 0.2 = 0.3 exactly (integer arithmetic)", () =>
    eq(Z.formatAmount(amt("0.1").zats + amt("0.2").zats), "0.3"),
  );
  t(
    "MAX_MONEY 21000000 accepted, +1 zatoshi rejected",
    () =>
      amt("21000000").ok && errCode(amt("21000000.00000001"), "max") === true,
  );
  t("9 decimal places rejected", () =>
    errCode(amt("0.000000001"), "precision"),
  );
  for (const bad of [
    "",
    ".5",
    "1.",
    "-1",
    "1e3",
    "1,5",
    "abc",
    "18446744073709551624",
  ])
    t(`Rejects "${bad}"`, () => !amt(bad).ok);

  /* --------------------------------------------------------------- memos */
  section("Memos", "librustzcash zip321 test_zip321_memos + ZIP-321 examples");
  t('"This is a simple memo."', () =>
    eq(
      Z.encodeMemo("This is a simple memo.").b64,
      "VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg",
    ),
  );
  t("Unicode memo ✨🦄🏆🎉", () =>
    eq(
      Z.encodeMemo("This is a unicode memo ✨\u{1f984}\u{1f3c6}\u{1f389}").b64,
      "VGhpcyBpcyBhIHVuaWNvZGUgbWVtbyDinKjwn6aE8J-PhvCfjok",
    ),
  );
  t("JSON-structured memo", () =>
    eq(
      Z.encodeMemo('{ "key": "This is a JSON-structured memo." }').b64,
      "eyAia2V5IjogIlRoaXMgaXMgYSBKU09OLXN0cnVjdHVyZWQgbWVtby4iIH0",
    ),
  );
  t(
    "512 bytes accepted, 513 rejected",
    () =>
      Z.encodeMemo("x".repeat(512)).ok &&
      errCode(Z.encodeMemo("x".repeat(513)), "memo-size") === true,
  );
  t(
    "Limit counts UTF-8 bytes, not characters",
    () =>
      Z.encodeMemo("✨".repeat(170)).ok && !Z.encodeMemo("✨".repeat(171)).ok,
  );
  t("Round trip through the strict decoder", () =>
    eq(Z.decodeMemo(Z.encodeMemo("Order #42 ☕").b64).text, "Order #42 ☕"),
  );
  t("Padded Base64 rejected", () => !Z.decodeMemo("aGk=").ok);
  t("Non-canonical trailing bits rejected", () => !Z.decodeMemo("aGl").ok);

  /* --------------------------------------------------------------- ZIP-321 render */
  section(
    "ZIP-321 rendering",
    "Byte-for-byte equality with librustzcash TransactionRequest::to_uri",
  );
  const SAP =
    "ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez";
  const TADDR = "tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU";
  const VALID_1 = `zcash:${SAP}?amount=1&memo=VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg&message=Thank%20you%20for%20your%20purchase`;
  const VALID_2 = `zcash:?address=${TADDR}&amount=123.456&address.1=${SAP}&amount.1=0.789&memo.1=VGhpcyBpcyBhIHVuaWNvZGUgbWVtbyDinKjwn6aE8J-PhvCfjok`;
  t("Spec valid_1 rendered exactly", () =>
    eq(
      Z.zip321.render([
        {
          address: SAP,
          zats: Z.COIN,
          memo: Z.encodeMemo("This is a simple memo.").bytes,
          message: "Thank you for your purchase",
        },
      ]),
      VALID_1,
    ),
  );
  t("Spec valid_2 survives parse → render unchanged", () => {
    const p = Z.zip321.parse(VALID_2);
    return p.ok
      ? eq(
          Z.zip321.render(
            p.payments.map((x) => ({
              address: x.address,
              zats: x.zats,
              memo: x.memo && x.memo.bytes,
            })),
          ),
          VALID_2,
        )
      : p.error;
  });
  t("Parameter order: amount, memo, label, message", () =>
    eq(
      Z.zip321.render([
        { address: SAP, zats: 5n, memo: enc("m"), label: "L", message: "M" },
      ]),
      `zcash:${SAP}?amount=0.00000005&memo=bQ&label=L&message=M`,
    ),
  );
  t("qchar: reserved characters percent-encoded", () =>
    eq(
      Z.zip321.qchar("Thanks & bye/ok? #1 = 100%"),
      "Thanks%20%26%20bye%2Fok%3F%20%231%20%3D%20100%25",
    ),
  );
  t("qchar: allowed delimiters kept", () =>
    eq(Z.zip321.qchar("!$'()*+,;:@-._~"), "!$'()*+,;:@-._~"),
  );
  t("qchar: UTF-8 percent-encoded", () =>
    eq(Z.zip321.qchar("€5"), "%E2%82%AC5"),
  );
  t('Three payments use indices "", .1, .2 (never .0)', () => {
    const u = Z.zip321.render(
      [1, 2, 3].map((n) => ({ address: SAP, zats: BigInt(n) * Z.COIN })),
    );
    return (
      u.startsWith(`zcash:?address=${SAP}&amount=1&address.1=`) &&
      u.includes("&amount.2=3") &&
      !u.includes(".0=")
    );
  });

  /* --------------------------------------------------------------- ZIP-321 parse */
  section(
    "ZIP-321 parsing",
    "librustzcash test_zip321_spec_valid_examples / invalid_examples / sprout tests",
  );
  const P = (u) => Z.zip321.parse(u);
  t(
    'valid_0 "zcash:" (no payments)',
    () => P("zcash:").ok && P("zcash:").payments.length === 0,
  );
  t(
    'valid_0 "zcash:?" (no payments)',
    () => P("zcash:?").ok && P("zcash:?").payments.length === 0,
  );
  t(
    "valid_1 amount = 100000000",
    () => P(VALID_1).ok && P(VALID_1).payments[0].zats === 100000000n,
  );
  t("valid_1 memo and message decoded", () => {
    const p = P(VALID_1).payments[0];
    return (
      p.memo.text === "This is a simple memo." &&
      p.message === "Thank you for your purchase"
    );
  });
  t("valid_2 amounts 12345600000 and 78900000", () => {
    const p = P(VALID_2);
    return (
      p.ok &&
      p.payments[0].zats === 12345600000n &&
      p.payments[1].zats === 78900000n
    );
  });
  t(
    "valid_3 amount 20999999.99999999",
    () =>
      P(`zcash:${SAP}?amount=20999999.99999999`).payments[0].zats ===
      2099999999999999n,
  );
  t(
    "valid_4 amount MAX_MONEY",
    () =>
      P(`zcash:${SAP}?amount=21000000`).payments[0].zats === 2100000000000000n,
  );
  t(
    "Empty message parsed",
    () =>
      P(
        "zcash:ztestsapling1n65uaftvs2g7075q2x2a04shfk066u3lldzxsrprfrqtzxnhc9ps73v4lhx4l9yfxj46sl0q90k?amount=3768769.02796286&message=",
      ).payments[0].message === "",
  );
  t("No query parameters", () => {
    const p = P(
      "zcash:ztestsapling1n65uaftvs2g7075q2x2a04shfk066u3lldzxsrprfrqtzxnhc9ps73v4lhx4l9yfxj46sl0q90k",
    );
    return p.ok && p.payments[0].zats === undefined;
  });
  t(
    "Regtest valid_1",
    () =>
      P(
        "zcash:zregtestsapling1qqqqqqqqqqqqqqqqqqcguyvaw2vjk4sdyeg0lc970u659lvhqq7t0np6hlup5lusxle7505hlz3?amount=1&memo=VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg&message=Thank%20you%20for%20your%20purchase",
      ).ok,
  );
  const invalid = [
    ["invalid_0 empty string", ""],
    [
      "invalid_1 missing address=",
      `zcash:?amount=3491405.05201255&address.1=${SAP}&amount.1=5740296.87793245`,
    ],
    [
      "invalid_2 missing address.1=",
      `zcash:?address=${TADDR}&amount=1&amount.1=2&address.2=${SAP}`,
    ],
    [
      "invalid_3 address.0= not permitted",
      `zcash:?address.0=${SAP}&amount.0=2`,
    ],
    [
      "invalid_4 duplicate amount=",
      `zcash:?amount=1.234&amount=2.345&address=${TADDR}`,
    ],
    [
      "invalid_5 duplicate amount.1=",
      `zcash:?amount.1=1.234&amount.1=2.345&address.1=${TADDR}`,
    ],
    [
      "invalid_6 memo to transparent address",
      `zcash:?address=${TADDR}&amount=123.456&memo=eyAia2V5IjogIlRoaXMgaXMgYSBKU09OLXN0cnVjdHVyZWQgbWVtby4iIH0&address.1=${SAP}&amount.1=0.789&memo.1=VGhpcyBpcyBhIHVuaWNvZGUgbWVtbyDinKjwn6aE8J-PhvCfjok`,
    ],
    ["invalid_7 amount exceeds i64", `zcash:${SAP}?amount=9223372036854775808`],
    ["invalid_7a amount wraps u64", `zcash:${SAP}?amount=18446744073709551624`],
    [
      "invalid_8 amount above MAX_MONEY",
      `zcash:${SAP}?amount=21000000.00000001`,
    ],
    ["invalid_9 negative amount", `zcash:${SAP}?amount=-1`],
    [
      "invalid_10 index too large",
      `zcash:?amount.10000=1.23&address.10000=${TADDR}`,
    ],
    ["invalid_11 bad amount format", `zcash:?address=${TADDR}&amount=123.`],
    [
      "invalid_12 unknown req- parameter",
      `zcash:?address=${TADDR}&amount=123.45&req-unknown=x`,
    ],
  ];
  for (const [name, uri] of invalid) t(name, () => !P(uri).ok);
  const SPROUT =
    "zc8E5gYid86n4bo2Usdq1cpr7PpfoJGzttwBHEEgGhGkLUg7SPPVFNB2AkRFXZ7usfphup5426dt1buMmY3fkYeRrQGLa8y";
  t("Sprout lead address rejected", () =>
    errCode(P(`zcash:${SPROUT}?amount=1&memo=aGk`), "sprout"),
  );
  t("Sprout address= rejected", () =>
    errCode(P(`zcash:?address=${SPROUT}&amount=1`), "sprout"),
  );
  t("Sprout address.3= rejected", () =>
    errCode(P(`zcash:?address.3=${SPROUT}&amount.3=1`), "sprout"),
  );
  t('Trailing "&" rejected', () => !P(`zcash:${SAP}?amount=1&`).ok);

  /* --------------------------------------------------------------- merchant policy */
  section("Merchant policy", "Zectill rules on top of the specs");
  const ua = V[0] ? V[0].unified_addr : "";
  t(
    "Official mainnet UA accepted on mainnet",
    () => Z.checkPayTo(ua, "main").ok,
  );
  t("Mainnet UA on testnet flagged as network mismatch", () => {
    const r = Z.checkPayTo(ua, "test");
    return r.mismatch === true && r.detected === "main";
  });
  t("Sapling address refused with an explanation", () =>
    errCode(
      Z.checkPayTo(
        "zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpq6d8g",
        "main",
      ),
      "kind",
    ),
  );
  t("Transparent address refused", () =>
    errCode(
      Z.checkPayTo("t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs", "main"),
      "kind",
    ),
  );
  t("Expired address refused", () => {
    const exp = new Uint8Array(8);
    new DataView(exp.buffer).setUint32(0, 1700000000, true);
    return errCode(
      Z.checkPayTo(
        Z.ua.encode("zu", [
          { typecode: 3, data: r43(0) },
          { typecode: 0xe1, data: exp },
        ]),
        "main",
      ),
      "expired",
    );
  });
  t("Unknown-receiver-only UA refused (no shielded receiver)", () =>
    errCode(
      Z.checkPayTo(
        Z.ua.encode("u", [{ typecode: 0x7f, data: new Uint8Array(40) }]),
        "main",
      ),
      "no-shielded",
    ),
  );
  t("Demo addresses are valid and recognisably demo", () =>
    ["main", "test"].every((n) => {
      const r = Z.checkPayTo(Z.demoAddress(n, 3), n);
      return r.ok && Z.isDemoAddress(r.info);
    }),
  );
  t(
    "Real addresses are not flagged as demo",
    () => !Z.isDemoAddress(Z.checkPayTo(ua, "main").info),
  );
  t("Upper-case UA normalised to lower case", () =>
    eq(Z.checkPayTo(ua.toUpperCase(), "main").value, ua),
  );

  /* --------------------------------------------------------------- batch parser */
  section("Batch line parser", "CSV / TSV / whitespace input");
  const A = (i) => Z.demoAddress("main", i);
  const COLS = [
    { key: "address", type: "address", label: "Recipient" },
    { key: "amount", type: "amount", label: "Amount" },
    { key: "memo", type: "memo", label: "Memo", optional: true },
  ];
  t("Comma, tab and space separated lines", () =>
    eq(
      Z.parseEntries(`${A(1)}, 0.25\n${A(2)}\t1\n${A(3)} 0.05`, "main", COLS)
        .rows.length,
      3,
    ),
  );
  t("Header row, blank lines and # comments skipped", () => {
    const r = Z.parseEntries(
      `address,amount,memo\n\n# note\n${A(1)},0.25`,
      "main",
      COLS,
    );
    return r.rows.length === 1 && r.issues.length === 0;
  });
  t("Quoted memo with a comma", () =>
    eq(
      Z.parseEntries(`${A(1)},1,"Rent, October"`, "main", COLS).rows[0].memo,
      "Rent, October",
    ),
  );
  t("Whitespace mode keeps the rest of the line as memo", () =>
    eq(
      Z.parseEntries(`${A(1)} 1 Thanks for October`, "main", COLS).rows[0].memo,
      "Thanks for October",
    ),
  );
  t("Bad lines reported by line number, good lines kept", () => {
    const r = Z.parseEntries(`${A(1)},0.25\nt1bad,1\n${A(2)},-3`, "main", COLS);
    return r.rows.length === 1 && r.issues.map((i) => i.line).join() === "2,3";
  });
  t("Duplicate recipient raises a warning", () =>
    Z.parseEntries(`${A(1)},1\n${A(1)},2`, "main", COLS).issues.some(
      (i) => i.level === "warning" && i.line === 2,
    ),
  );
  t(
    "Amount with a ZEC suffix accepted",
    () =>
      Z.parseEntries(`${A(1)}, 1.5 ZEC`, "main", COLS).rows[0].amount ===
      150000000n,
  );

  /* --------------------------------------------------------------- reconcile */
  section("Payment matching", "Wallet history → invoices");
  const INV = [
    { id: "INV-AAAAAA", zats: 50000000n, status: "pending" },
    { id: "INV-BBBBBB", zats: 100000000n, status: "pending" },
    { id: "INV-CCCCCC", zats: 10000000n, status: "paid" },
    { id: "INV-DDDDDD", zats: 20000000n, status: "pending" },
  ];
  const tx = "ab".repeat(32);
  const memoHex =
    Array.from(new TextEncoder().encode("INV-DDDDDD · table 4"), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("") + "00".repeat(20);
  const rec = Z.reconcile(
    [
      `2026-10-27 14:05, received, 0.5 ZEC, "INV-AAAAAA · coffee", ${tx}`,
      "received 0.4 memo INV-BBBBBB",
      "INV-CCCCCC 0.1",
      `{"txid": "${"cd".repeat(32)}", "amount": 0.20000000, "memo": "${memoHex}"}`,
      "INV-AAAAAAX should not match",
    ].join("\n"),
    INV,
  );
  const verdict = (id) => (rec.matches.find((m) => m.id === id) || {}).verdict;
  t(
    "Exact amount → paid, txid captured",
    () =>
      verdict("INV-AAAAAA") === "paid" &&
      rec.matches.find((m) => m.id === "INV-AAAAAA").txids[0] === tx,
  );
  t("Short payment → partial", () => eq(verdict("INV-BBBBBB"), "partial"));
  t("Already-paid invoice flagged", () =>
    eq(verdict("INV-CCCCCC"), "already-paid"),
  );
  t("Hex-encoded memo (zcashd JSON) decoded and matched", () =>
    eq(verdict("INV-DDDDDD"), "paid"),
  );
  t(
    "IDs must match whole tokens",
    () => rec.matches.find((m) => m.id === "INV-AAAAAA").lines.length === 1,
  );
  t("Memo matches report via = memo", () =>
    eq(rec.matches.find((m) => m.id === "INV-AAAAAA").via, "memo"),
  );

  /* --------------------------------------------------------------- batch requests */
  section(
    "Batch requests",
    "Payout, bill split and settlement requests, parsed back as a wallet would",
  );
  const rowsOf = (mode, text) =>
    Z.parseEntries(text, "main", Z.BATCH_COLUMNS[mode]).rows;
  const parsedAll = (b) => b.requests.map((q) => Z.zip321.parse(q.uri));
  const payout = Z.buildBatch(
    "one-many",
    rowsOf("one-many", `${A(1)},0.25,Rent\n${A(2)},1\n${A(3)},0.05,Bonus`),
  );
  t("Payout: one request for the whole list", () =>
    eq(payout.requests.length, 1),
  );
  t("Payout: each memo stays with its own payment (memo, memo.2; no memo.1)", () => {
    const u = payout.requests[0].uri;
    return u.includes("&memo=") && u.includes("&memo.2=") && !u.includes("memo.1=");
  });
  t("Payout: a wallet reads back 3 payments, their memos and a 1.3 ZEC total", () => {
    const p = Z.zip321.parse(payout.requests[0].uri);
    return (
      p.ok &&
      p.payments.length === 3 &&
      p.payments.map((x) => (x.memo ? x.memo.text : "")).join("|") === "Rent||Bonus" &&
      Z.formatAmount(p.total) === "1.3"
    );
  });
  t("Payout of one person uses the address-in-path form", () =>
    Z.buildBatch("one-many", rowsOf("one-many", `${A(4)},0.5`)).requests[0].uri.startsWith(
      `zcash:${A(4)}?amount=0.5`,
    ),
  );
  const merchant = A(9);
  const split = Z.buildBatch("many-one", rowsOf("many-one", "Ada, 0.42\nBen, 0.38"), {
    merchant,
    ref: "DINNER",
  });
  t("Bill split: one request per person, all paying the merchant", () =>
    split.requests.length === 2 &&
    parsedAll(split).every((p) => p.ok && p.payments[0].address === merchant),
  );
  t("Bill split: memo is \"reference · name\" and amounts are per person", () => {
    const p = parsedAll(split);
    return (
      p[0].payments[0].memo.text === "DINNER · Ada" &&
      p[1].payments[0].memo.text === "DINNER · Ben" &&
      Z.formatAmount(p[1].payments[0].zats) === "0.38"
    );
  });
  t("Bill split without a reference: memo is just the name", () =>
    eq(
      Z.zip321.parse(
        Z.buildBatch("many-one", rowsOf("many-one", "Ada, 1"), { merchant }).requests[0].uri,
      ).payments[0].memo.text,
      "Ada",
    ),
  );
  t("Bill split with no receiving address builds nothing", () =>
    eq(Z.buildBatch("many-one", rowsOf("many-one", "Ada, 1"), {}).requests.length, 0),
  );
  t("Settlement: each request pays that line's recipient", () => {
    const b = Z.buildBatch(
      "many-many",
      rowsOf("many-many", `Ada, ${A(2)}, 0.4\nBen, ${A(3)}, 0.35`),
      { ref: "TRIP" },
    );
    const p = parsedAll(b);
    return (
      p[0].payments[0].address === A(2) &&
      p[1].payments[0].address === A(3) &&
      p[1].payments[0].memo.text === "TRIP · Ben"
    );
  });
  t("A memo over 512 bytes is reported for that line and skipped", () => {
    const b = Z.buildBatch("many-one", rowsOf("many-one", "Ada, 1\nBen, 2"), {
      merchant,
      ref: "x".repeat(510),
    });
    return b.requests.length === 0 && b.issues.map((i) => i.line).join() === "1,2";
  });

  /* --------------------------------------------------------------- unique amounts */
  section(
    "Unique amounts",
    "Per-invoice amount tags, and matching when a wallet drops the memo",
  );
  const ids = Array.from({ length: 200 }, (_, i) => "INV-" + (100000 + i * 7919).toString(36).toUpperCase());
  t("Tags are 1–999 zatoshis and always the same for the same ID", () =>
    ids.every((id) => {
      const g = Z.amountTag(id);
      return g >= 1n && g <= 999n && g === Z.amountTag(id);
    }),
  );
  t("Different IDs almost always get different tags", () =>
    new Set(ids.map((id) => String(Z.amountTag(id)))).size >= 175,
  );
  t("Round amounts are untagged; tagged amounts are recognised", () =>
    !Z.hasTag(Z.COIN / 4n) && Z.hasTag(Z.COIN / 4n + Z.amountTag("INV-X")),
  );
  const tag1 = Z.amountTag("INV-TAG001"), tag2 = Z.amountTag("INV-TAG002");
  const due1 = 25000000n + tag1, due2 = 30000000n + tag2;
  const byAmt = Z.reconcile(
    [
      `2026-10-28 10:00, ${Z.formatAmount(due1)}, , ${"ef".repeat(32)}`,
      "2026-10-28 10:05, 0.5, no memo",
      `2026-10-28 10:09, ${Z.formatAmount(due2)}, "INV-TAG002 · Table 2"`,
    ].join("\n"),
    [
      { id: "INV-TAG001", zats: due1, status: "pending" },
      { id: "INV-TAG002", zats: due2, status: "pending" },
      { id: "INV-ROUND5", zats: 50000000n, status: "pending" },
    ],
  );
  const hit = (id) => byAmt.matches.find((m) => m.id === id);
  t("No memo, exact tagged amount: matched and paid, via amount", () =>
    hit("INV-TAG001") && hit("INV-TAG001").verdict === "paid" && hit("INV-TAG001").via === "amount",
  );
  t("Untagged round amounts are never matched by amount alone", () => !hit("INV-ROUND5"));
  t("A precise untagged price (0.23726834) is matched by amount alone", () => {
    const m = Z.reconcile("2026-10-28 11:00, 0.23726834, no memo", [
      { id: "INV-PREC01", zats: 23726834n, status: "pending" },
    ]).matches[0];
    return m && m.id === "INV-PREC01" && m.verdict === "paid" && m.via === "amount";
  });
  t("When the memo has the ID, the match is via memo", () => eq(hit("INV-TAG002").via, "memo"));
  t("An amount shared by two open invoices is not matched by amount", () => {
    const amb = Z.reconcile(`10:00, ${Z.formatAmount(due1)}`, [
      { id: "INV-AMB001", zats: due1, status: "pending" },
      { id: "INV-AMB002", zats: due1, status: "pending" },
    ]);
    return amb.matches.length === 0;
  });
  t("Paid invoices are never matched by amount", () =>
    Z.reconcile(`10:00, ${Z.formatAmount(due1)}`, [
      { id: "INV-PAID01", zats: due1, status: "paid" },
    ]).matches.length === 0,
  );

  render();

  /* ================================================================ output */
  function render() {
    const all = groups.flatMap((g) => g.results),
      failed = all.filter((r) => !r.ok).length;
    document.title = `${failed ? "FAIL" : "PASS"} ${all.length - failed}/${all.length} · Zectill tests`;
    const sum = document.getElementById("summary");
    sum.dataset.pass = all.length - failed;
    sum.dataset.fail = failed;
    sum.className = "summary " + (failed ? "is-fail" : "is-pass");
    sum.querySelector(".summary-count").textContent =
      `${all.length - failed} / ${all.length}`;
    sum.querySelector(".summary-text").textContent = failed
      ? `${failed} check${failed === 1 ? "" : "s"} failed`
      : "All checks passed";
    const root = document.getElementById("groups");
    for (const g of groups) {
      const bad = g.results.filter((r) => !r.ok).length;
      const d = document.createElement("details");
      d.className = "test-group" + (bad ? " has-fail" : "");
      d.open = bad > 0;
      const s = document.createElement("summary");
      s.innerHTML =
        '<span class="tg-name"></span><span class="tg-source"></span><span class="tg-count"></span>';
      s.querySelector(".tg-name").textContent = g.name;
      s.querySelector(".tg-source").textContent = g.source;
      s.querySelector(".tg-count").textContent =
        `${g.results.length - bad}/${g.results.length}`;
      const ul = document.createElement("ul");
      for (const r of g.results) {
        const li = document.createElement("li");
        li.className = r.ok ? "ok" : "bad";
        li.textContent =
          (r.ok ? "✓ " : "✗ ") + r.name + (r.detail ? ` (${r.detail})` : "");
        ul.append(li);
      }
      d.append(s, ul);
      root.append(d);
    }
    document.getElementById("plain").textContent = all
      .map(
        (r) =>
          (r.ok ? "PASS " : "FAIL ") +
          r.name +
          (r.detail ? " :: " + r.detail : ""),
      )
      .join("\n");
  }

  /* ================================================================ wallet kit */
  const KIT_KEY = "zectill.v2.walletkit";
  const CASES = [
    {
      id: "single",
      name: "Single payment",
      build: (a) => [{ address: a, zats: 100000n }],
    },
    {
      id: "memo",
      name: "Text memo",
      build: (a) => [
        { address: a, zats: 100000n, memo: enc("Zectill wallet test") },
      ],
    },
    {
      id: "unicode",
      name: "Unicode memo",
      build: (a) => [
        { address: a, zats: 100000n, memo: enc("Zectill ✨ test ☕") },
      ],
    },
    {
      id: "label",
      name: "Label + message",
      build: (a) => [
        {
          address: a,
          zats: 100000n,
          label: "Coffee #42",
          message: "Thanks for testing Zectill!",
        },
      ],
    },
    {
      id: "batch",
      name: "Two payments",
      build: (a) => [
        { address: a, zats: 100000n },
        { address: a, zats: 200000n },
      ],
    },
    {
      id: "batchmemo",
      name: "Two payments + memos",
      build: (a) => [
        { address: a, zats: 100000n, memo: enc("Payout 1") },
        { address: a, zats: 200000n, memo: enc("Payout 2") },
      ],
    },
  ];
  const RESULTS = [
    ["works", "✅ works"],
    ["partial", "⚠️ partial"],
    ["fails", "❌ fails"],
  ];
  const kit = (() => {
    try {
      return JSON.parse(localStorage.getItem(KIT_KEY)) || {};
    } catch (e) {
      return {};
    }
  })();
  const saveKit = () => {
    try {
      localStorage.setItem(KIT_KEY, JSON.stringify(kit));
    } catch (e) {
      /* storage blocked */
    }
  };
  const $ = (id) => document.getElementById(id);

  function qrCanvas(text) {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    const n = q.getModuleCount(),
      cell = Math.max(2, Math.floor(480 / (n + 8))),
      size = (n + 8) * cell;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const x = c.getContext("2d");
    x.fillStyle = "#fff";
    x.fillRect(0, 0, size, size);
    x.fillStyle = "#0b0f14";
    for (let r = 0; r < n; r++)
      for (let k = 0; k < n; k++)
        if (q.isDark(r, k))
          x.fillRect((k + 4) * cell, (r + 4) * cell, cell, cell);
    return c;
  }

  function renderKit() {
    const addr = $("kit-addr").value.trim(),
      wallet = $("kit-wallet").value.trim(),
      box = $("kit-cases"),
      status = $("kit-status");
    kit.addr = addr;
    kit.wallet = wallet;
    saveKit();
    box.replaceChildren();
    if (!addr) {
      status.textContent =
        "Paste your own testnet Unified Address (utest1…) to generate the test requests.";
      return;
    }
    const a = Z.classifyAddress(addr);
    if (!a.ok || a.kind !== "unified") {
      status.textContent = a.ok ? "Use a Unified Address." : a.error;
      return;
    }
    status.textContent =
      `${a.net === "test" ? "Testnet" : a.net === "main" ? "Mainnet: each test sends real ZEC (tiny amounts)" : a.net} · ${a.receivers.join(" + ")}` +
      (Z.isDemoAddress(a)
        ? " · This is a Zectill demo address, so wallets will refuse it. Use your own."
        : "");
    const results = ((kit.results = kit.results || {})[wallet || "(unnamed)"] =
      kit.results[wallet || "(unnamed)"] || {});
    for (const c of CASES) {
      const uri = Z.zip321.render(c.build(a.address));
      const card = document.createElement("div");
      card.className = "kit-case";
      const h = document.createElement("h3");
      h.textContent = c.name;
      let qr;
      try {
        qr = qrCanvas(uri);
      } catch (e) {
        qr = document.createElement("p");
        qr.textContent = "QR unavailable";
      }
      const code = document.createElement("code");
      code.textContent = uri;
      const open = document.createElement("a");
      open.href = uri;
      open.textContent = "Open in wallet";
      open.className = "kit-link";
      const row = document.createElement("div");
      row.className = "kit-results";
      row.setAttribute("role", "radiogroup");
      row.setAttribute("aria-label", `Result for ${c.name}`);
      for (const [v, label] of RESULTS) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(results[c.id] === v));
        b.onclick = () => {
          results[c.id] = results[c.id] === v ? undefined : v;
          saveKit();
          renderKit();
        };
        row.append(b);
      }
      card.append(h, qr, code, open, row);
      box.append(card);
    }
  }

  function markdown() {
    const head = `| Wallet | ${CASES.map((c) => c.name).join(" | ")} |\n|---|${CASES.map(() => "---").join("|")}|`;
    const rows = Object.entries(kit.results || {}).map(
      ([w, r]) =>
        `| ${w} | ${CASES.map((c) => (RESULTS.find(([v]) => v === r[c.id]) || [, "–"])[1]).join(" | ")} |`,
    );
    return [head, ...rows].join("\n");
  }

  $("kit-addr").value = kit.addr || "";
  $("kit-wallet").value = kit.wallet || "";
  $("kit-addr").addEventListener("input", renderKit);
  $("kit-wallet").addEventListener("change", renderKit);
  $("kit-copy").addEventListener("click", async () => {
    const md = markdown();
    try {
      await navigator.clipboard.writeText(md);
      $("kit-copy").textContent = "Copied";
    } catch (e) {
      $("kit-md").hidden = false;
    }
    $("kit-md").textContent = md;
    setTimeout(() => {
      $("kit-copy").textContent = "Copy results as Markdown";
    }, 1500);
  });
  if (typeof qrcode === "function") renderKit();
  else $("kit-status").textContent = "QR library failed to load.";
})();
