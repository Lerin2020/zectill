/* This file only manages the page, browser storage and the optional exchange-rate lookup. */
(function () {
  "use strict";
  if (/[?&]selftest=1/.test(location.search)) {
    location.replace("tests.html");
    return;
  }
  const Z = window.ZcashKit;

  /* ============================================================ helpers */

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs)
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class") e.className = v;
        else if (k === "text") e.textContent = v;
        else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? "" : v);
      }
    for (const kid of kids.flat(Infinity))
      if (kid != null && kid !== false)
        e.append(kid.nodeType ? kid : String(kid));
    return e;
  }
  function icon(name) {
    const s = document.createElementNS(SVG_NS, "svg"),
      u = document.createElementNS(SVG_NS, "use");
    s.setAttribute("class", "icon");
    s.setAttribute("aria-hidden", "true");
    u.setAttribute("href", "#i-" + name);
    s.append(u);
    return s;
  }
  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };
  const nowIso = () => new Date().toISOString();
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const short = (a, head = 12, tail = 8) =>
    a && a.length > head + tail + 1
      ? `${a.slice(0, head)}…${a.slice(-tail)}`
      : a || "";
  const coinOf = (net) => (Z.NETS[net] || Z.NETS.main).coin;
  const fmtZ = (zats) => Z.formatAmount(BigInt(zats));
  /* The price at full weight, the unique-amount tag's digits faded after it: 0.5 + 000059. */
  function amountNodes(zats, tag) {
    const whole = Z.formatAmount(zats);
    if (!tag) return [whole];
    const head = Z.formatAmount(zats - BigInt(tag));
    if (head === whole || !whole.startsWith(head)) return [whole];
    return [
      head,
      el("span", { class: "amt-tag", title: "Unique tag that lets this payment be matched without its memo", text: whole.slice(head.length) }),
    ];
  }
  const fmtDate = (iso) =>
    new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  const fmtLeft = (ms) => {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  function fmtFiat(v, cur, whole) {
    try {
      return new Intl.NumberFormat(
        undefined,
        whole
          ? {
              style: "currency",
              currency: cur,
              maximumFractionDigits: 0,
              minimumFractionDigits: 0,
            }
          : { style: "currency", currency: cur },
      ).format(v);
    } catch (e) {
      return `${v} ${cur}`;
    }
  }
  function relTime(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 45) return "just now";
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
    if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
    if (s < 7 * 86400) return rtf.format(-Math.round(s / 86400), "day");
    return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
  }

  /* ============================================================ storage */

  const KEYS = {
    invoices: "zectill.v2.invoices",
    batches: "zectill.v2.batches",
    settings: "zectill.v2.settings",
    net: "zectill.v2.net",
    theme: "zectill.theme",
    legacy: "zectill.invoices.v1",
    addr: (n) => "zectill.v2.addr." + n,
    pin: "zectill.v2.pin",
    pinFails: "zectill.v2.pinfails",
    posLock: "zectill.v2.poslock",
  };
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        toast("Could not save: browser storage is full or blocked.", "error");
        return false;
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch (e) {
        /* storage blocked */
      }
    },
  };

  const CURRENCIES = [
    "USD",
    "EUR",
    "GBP",
    "NGN",
    "ZAR",
    "INR",
    "BRL",
    "MXN",
    "CAD",
    "AUD",
    "CHF",
    "JPY",
  ];
  const CHIP_SCALE = {
    NGN: 1000,
    JPY: 100,
    INR: 100,
    ZAR: 10,
    BRL: 10,
    MXN: 10,
  };
  const RATE_URL =
    "https://api.coingecko.com/api/v3/simple/price?ids=zcash&vs_currencies=";
  const settings = Object.assign(
    {
      business: "",
      currency: "USD",
      lockMin: 15,
      remember: true,
      uniqueAmounts: true,
    },
    store.get(KEYS.settings, {}),
  );
  if (!CURRENCIES.includes(settings.currency)) settings.currency = "USD";
  const saveSettings = () => store.set(KEYS.settings, settings);

  const S = {
    net: store.get(KEYS.net, "main") === "test" ? "test" : "main",
    tab: "invoice",
    unit: "coin", // amount entered in 'coin' (ZEC/TAZ) or 'fiat'
    current: null, // saved invoice shown (locked) in the editor, or null while drafting
    quote: null, // { fiat, cur, rate, zats, at, expires } | { loading } | { error }
    rates: null,
    ratesAt: 0,
    touched: new Set(),
    submitted: false,
    filter: "all",
    search: "",
    batchMode: "one-many",
    batchOut: [],
    batchSel: 0,
    posId: null,
    posReturn: null,
    wakeLock: null,
    match: null,
  };

  /* ============================================================ feedback */

  function toast(msg, type = "info", action) {
    const t = el(
      "div",
      {
        class: "toast toast-" + type,
        role: type === "error" ? "alert" : "status",
      },
      icon(type === "success" ? "check" : type === "error" ? "alert" : "info"),
      el("span", { class: "toast-msg", text: msg }),
    );
    let gone = false;
    const dismiss = () => {
      if (gone) return;
      gone = true;
      t.classList.add("is-leaving");
      setTimeout(() => t.remove(), 220);
    };
    if (action)
      t.append(
        el("button", {
          type: "button",
          class: "toast-action",
          text: action.label,
          onclick: () => {
            action.run();
            dismiss();
          },
        }),
      );
    $("toasts").append(t);
    while ($("toasts").children.length > 3)
      $("toasts").firstElementChild.remove();
    setTimeout(dismiss, action ? 6500 : 3800);
  }

  async function copyText(text, msg) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      const ta = el("textarea", { class: "sr-only", readonly: true });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch (err) {
        ok = false;
      }
      ta.remove();
    }
    toast(
      ok ? msg : "Copy failed. Select the text and copy it manually.",
      ok ? "success" : "error",
    );
    return ok;
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob),
      a = el("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function confirmDialog({ title, body, ok = "Confirm", danger = false }) {
    const d = $("dlg-confirm");
    $("cf-title").textContent = title;
    $("cf-body").textContent = body;
    $("cf-ok").textContent = ok;
    $("cf-ok").className = "btn " + (danger ? "btn-danger" : "btn-primary");
    d.returnValue = "";
    return new Promise((resolve) => {
      d.addEventListener("close", () => resolve(d.returnValue === "ok"), {
        once: true,
      });
      d.showModal();
    });
  }

  function setStatus(id, kind, content) {
    const box = $(id);
    box.className = "field-status" + (kind ? " is-" + kind : "");
    box.replaceChildren();
    if (!content) return;
    if (kind)
      box.append(
        icon(kind === "ok" ? "check" : kind === "error" ? "alert" : "info"),
      );
    box.append(
      typeof content === "string" ? el("span", { text: content }) : content,
    );
  }
  const setInvalid = (id, bad) =>
    $(id).setAttribute("aria-invalid", bad ? "true" : "false");
  function setBadge(id, text, cls) {
    const b = $(id);
    b.textContent = text;
    b.className = "badge" + (cls ? " " + cls : "");
  }
  function setLink(a, href) {
    if (href) {
      a.href = href;
      a.removeAttribute("aria-disabled");
      a.tabIndex = 0;
    } else {
      a.removeAttribute("href");
      a.setAttribute("aria-disabled", "true");
      a.tabIndex = -1;
    }
  }

  /** Radio groups and tab lists with roving tabindex and arrow-key navigation. */
  function segmented(root, onChange) {
    const btns = $$("[data-v]", root);
    const attr =
      btns[0] && btns[0].getAttribute("role") === "tab"
        ? "aria-selected"
        : "aria-checked";
    const set = (v) =>
      btns.forEach((b) => {
        const on = b.dataset.v === v;
        b.setAttribute(attr, String(on));
        b.tabIndex = on ? 0 : -1;
      });
    btns.forEach((b, i) => {
      b.addEventListener("click", () => {
        if (b.disabled) return;
        set(b.dataset.v);
        onChange(b.dataset.v);
      });
      b.addEventListener("keydown", (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
          e.key
        ];
        if (!d) return;
        e.preventDefault();
        for (let j = 1; j < btns.length; j++) {
          const n = btns[(i + d * j + btns.length * j) % btns.length];
          if (!n.disabled) {
            n.focus();
            n.click();
            break;
          }
        }
      });
    });
    return set;
  }

  /* ============================================================ QR codes */

  const QR = {
    make(text) {
      if (typeof qrcode !== "function")
        throw Object.assign(new Error("QR library missing"), { code: "lib" });
      for (const ec of ["M", "L"]) {
        try {
          const q = qrcode(0, ec);
          q.addData(text, "Byte");
          q.make();
          return { q, n: q.getModuleCount() };
        } catch (e) {
          /* too long at this level, try the next */
        }
      }
      throw Object.assign(new Error("Too long for one QR code"), {
        code: "long",
      });
    },
    /** Crisp canvas with a 4-module quiet zone, roughly `px` pixels square. */
    canvas(text, px = 720) {
      const { q, n } = QR.make(text);
      const cell = Math.max(2, Math.ceil(px / (n + 8))),
        size = (n + 8) * cell;
      const c = el("canvas", { width: size, height: size });
      const x = c.getContext("2d");
      x.fillStyle = "#fff";
      x.fillRect(0, 0, size, size);
      x.fillStyle = "#0b0f14";
      for (let r = 0; r < n; r++)
        for (let k = 0; k < n; k++)
          if (q.isDark(r, k))
            x.fillRect((k + 4) * cell, (r + 4) * cell, cell, cell);
      c.dataset.version = String((n - 17) / 4);
      return c;
    },
  };

  function QRView(frameId, emptyId, msgId, stageId) {
    const frame = $(frameId),
      empty = $(emptyId),
      msg = $(msgId),
      stage = $(stageId);
    return {
      show(text, label) {
        try {
          const c = QR.canvas(text);
          frame.replaceChildren(c);
          frame.setAttribute("aria-label", label);
          frame.hidden = false;
          empty.hidden = true;
          stage.classList.add("is-ready");
          return { ok: true, version: +c.dataset.version };
        } catch (e) {
          this.clear(
            e.code === "lib"
              ? "QR library failed to load. The payment link still works."
              : "Too much data for one QR code. Share the link instead.",
          );
          return { ok: false };
        }
      },
      clear(text) {
        frame.replaceChildren();
        frame.hidden = true;
        empty.hidden = false;
        msg.textContent = text;
        stage.classList.remove("is-ready");
      },
    };
  }

  function densityTag(target, res, uri) {
    target.replaceChildren();
    if (!res || !res.ok) return;
    const dense = res.version >= 15;
    target.append(
      el(
        "span",
        {
          class: "tag" + (dense ? " tag-warn" : ""),
          title: `QR version ${res.version}, ${uri.length} characters`,
        },
        dense
          ? `Dense code (version ${res.version}): scan from close up`
          : `QR version ${res.version} · ${uri.length} characters`,
      ),
    );
  }

  /** A shareable 1080px-wide payment card: optional title, QR, amount and a subtitle. */
  function paymentPng(uri, { title, amount, sub }, name) {
    let qr;
    try {
      qr = QR.canvas(uri, 1200);
    } catch (e) {
      return toast("This request is too long for a QR image.", "error");
    }
    const W = 1080,
      P = 72,
      Q = W - 2 * P;
    const H = P + (title ? 76 : 0) + Q + 36 + 88 + (sub ? 52 : 0) + 56 + P;
    const c = el("canvas", { width: W, height: H }),
      x = c.getContext("2d");
    const font = (w, s) =>
      `${w} ${s}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
    const fit = (text, w, size) => {
      x.font = font(w, size);
      while (size > 18 && x.measureText(text).width > Q) {
        size -= 2;
        x.font = font(w, size);
      }
    };
    x.fillStyle = "#fff";
    x.fillRect(0, 0, W, H);
    x.textAlign = "center";
    let y = P;
    if (title) {
      x.fillStyle = "#0d1419";
      fit(title, 800, 46);
      x.fillText(title, W / 2, y + 46);
      y += 76;
    }
    x.imageSmoothingEnabled = false;
    x.drawImage(qr, P, y, Q, Q);
    y += Q + 36;
    x.fillStyle = "#0d1419";
    fit(amount, 850, 78);
    x.fillText(amount, W / 2, y + 70);
    y += 88;
    if (sub) {
      x.fillStyle = "#3c4651";
      fit(sub, 600, 34);
      x.fillText(sub, W / 2, y + 38);
      y += 52;
    }
    x.fillStyle = "#5d6874";
    x.font = font(500, 28);
    x.fillText("Scan with any Zcash wallet", W / 2, y + 40);
    c.toBlob(
      (b) =>
        b
          ? downloadBlob(b, name)
          : toast("Could not create the image.", "error"),
      "image/png",
    );
  }

  async function printNode(node) {
    const root = $("print-root");
    root.replaceChildren(node);
    await Promise.all(
      $$("img", root).map((i) =>
        i.decode ? i.decode().catch(() => {}) : null,
      ),
    );
    window.print();
  }
  const qrImg = (uri, alt) => {
    try {
      return el("img", {
        src: QR.canvas(uri, 640).toDataURL("image/png"),
        alt,
      });
    } catch (e) {
      return el("p", { text: "QR unavailable: use the link below." });
    }
  };

  /* ============================================================ theme */

  const THEME_ICON = { dark: "moon", light: "sun", system: "monitor" };
  const THEME_NEXT = { dark: "light", light: "system", system: "dark" };
  const THEME_NAME = { dark: "dark", light: "light", system: "automatic" };
  const darkMq = matchMedia("(prefers-color-scheme: dark)");
  let themePref = ["dark", "light", "system"].includes(
    document.documentElement.dataset.themePref,
  )
    ? document.documentElement.dataset.themePref
    : "dark";
  let setThemeSeg = () => {};

  function applyTheme(pref, save) {
    themePref = pref;
    const dark = pref === "dark" || (pref === "system" && darkMq.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]').content = dark
      ? "#0f1318"
      : "#ffffff";
    const btn = $("theme-btn"),
      label = `Theme: ${THEME_NAME[pref]}. Switch to ${THEME_NAME[THEME_NEXT[pref]]}.`;
    btn.querySelector("use").setAttribute("href", "#i-" + THEME_ICON[pref]);
    btn.setAttribute("aria-label", label);
    btn.title = label;
    setThemeSeg(pref);
    if (save) {
      try {
        localStorage.setItem(KEYS.theme, pref);
      } catch (e) {
        /* storage blocked */
      }
    }
  }

  /* ============================================================ invoices store */

  const Inv = {
    all() {
      const a = store.get(KEYS.invoices, []);
      return Array.isArray(a)
        ? a.filter((r) => r && typeof r.id === "string" && r.zats)
        : [];
    },
    save(list) {
      const ok = store.set(KEYS.invoices, list);
      refreshCounts();
      return ok;
    },
    get(id) {
      return Inv.all().find((r) => r.id === id) || null;
    },
    put(rec) {
      const list = Inv.all(),
        i = list.findIndex((r) => r.id === rec.id);
      rec.updatedAt = nowIso();
      if (i < 0) list.push(rec);
      else list[i] = rec;
      Inv.save(list);
      changed(rec.id);
      return rec;
    },
    patch(id, fn) {
      const list = Inv.all(),
        r = list.find((x) => x.id === id);
      if (!r) return null;
      fn(r);
      r.updatedAt = nowIso();
      Inv.save(list);
      changed(id);
      return r;
    },
    remove(id) {
      const list = Inv.all(),
        i = list.findIndex((x) => x.id === id);
      if (i < 0) return null;
      const [r] = list.splice(i, 1);
      Inv.save(list);
      changed(id);
      return r;
    },
  };

  function changed(id) {
    if (S.current && S.current.id === id) {
      const r = Inv.get(id);
      if (r) {
        S.current = r;
        renderCurrent();
      } else startDraft();
    }
    if (S.tab === "invoices") renderHistory();
    if (S.posId === id) renderPOS();
  }

  const isOpen = (r) => r.status === "pending" || r.status === "partial";

  /* Payments add up: a part-paid invoice stays open and asks only for its balance. */
  const receivedOf = (r) =>
    r.receivedZats && (r.status === "partial" || r.status === "paid")
      ? BigInt(r.receivedZats)
      : 0n;
  const balanceOf = (r) => {
    const left = BigInt(r.zats) - receivedOf(r);
    return left > 0n ? left : 0n;
  };
  const paymentsOf = (r) =>
    r.payments ||
    (r.receivedZats
      ? [{ zats: r.receivedZats, txid: r.txid || "", at: r.paidAt, via: r.paidVia }]
      : []);
  /* What the customer is asked to pay now: the whole invoice, or a part-paid invoice's balance
     (same address and memo, so the balance payment is matched to the same invoice). */
  function requestOf(r) {
    if (r.status !== "partial")
      return { uri: r.uri, zats: BigInt(r.zats), tag: r.amountTag, balance: false };
    const zats = balanceOf(r);
    return {
      zats,
      tag: null,
      balance: true,
      uri: Z.zip321.render([
        {
          address: r.address,
          zats,
          memo: Z.encodeMemo(r.memo || "").bytes,
          label: r.label || null,
          message: r.message || null,
        },
      ]),
    };
  }
  const isExpired = (r) =>
    r.status === "pending" &&
    !!r.expiresAt &&
    Date.parse(r.expiresAt) <= Date.now();
  function statusInfo(r) {
    if (r.status === "paid") return { label: "Paid", cls: "badge-ok" };
    if (r.status === "partial")
      return { label: "Part-paid", cls: "badge-warn" };
    if (r.status === "void") return { label: "Void", cls: "" };
    if (isExpired(r)) return { label: "Quote expired", cls: "badge-danger" };
    return { label: "Open", cls: "badge-warn badge-live" };
  }

  const ID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U
  function newInvoiceId() {
    const taken = new Set(Inv.all().map((r) => r.id));
    for (;;) {
      const id =
        "INV-" +
        Array.from(
          crypto.getRandomValues(new Uint8Array(6)),
          (b) => ID_CHARS[b & 31],
        ).join("");
      if (!taken.has(id)) return id;
    }
  }

  /* Imports invoices saved by the earlier single-file version (zectill.invoices.v1). */
  function migrateLegacy() {
    if (store.get(KEYS.invoices, null) !== null) return;
    const old = store.get(KEYS.legacy, null);
    if (!Array.isArray(old) || !old.length) return;
    const list = [];
    for (const r of old) {
      const a = Z.parseAmount(r && r.amount),
        p = Z.zip321.parse(r && r.uri);
      if (!r.id || !a.ok || !p.ok || !p.payments.length) continue;
      list.push({
        id: String(r.id),
        net: r.net === "test" ? "test" : "main",
        address: p.payments[0].address,
        zats: String(a.zats),
        label: "",
        message: "",
        note: "",
        memo: (p.payments[0].memo && p.payments[0].memo.text) || "",
        uri: r.uri,
        fiat: null,
        expiresAt: null,
        status: r.status === "paid" ? "paid" : "pending",
        createdAt: r.created || nowIso(),
        updatedAt: nowIso(),
        paidAt: r.paidAt || null,
        txid: r.txid || "",
        receivedZats: null,
      });
    }
    if (list.length) store.set(KEYS.invoices, list);
  }

  function refreshCounts() {
    const open = Inv.all().filter(
      (r) => r.net === S.net && isOpen(r) && !isExpired(r),
    ).length;
    $("tab-count").textContent = open ? String(open) : "";
  }

  /* ============================================================ network */

  let setNetSeg = () => {};

  function setNetwork(net, { silent } = {}) {
    if (net !== "main" && net !== "test") return;
    const was = S.net;
    S.net = net;
    store.set(KEYS.net, net);
    setNetSeg(net);
    $$(".coin").forEach((e) => {
      e.textContent = coinOf(net);
    });
    $("net-banner").hidden = net !== "test";
    $("inv-address").placeholder = $("b-merchant").placeholder =
      Z.NETS[net].uaPrefix + "…";
    const fiatBtn = $("inv-unit-fiat");
    fiatBtn.disabled = net === "test";
    fiatBtn.title = net === "test" ? "TAZ has no market price" : "";
    if (net === "test" && S.unit === "fiat") setUnit("coin", { quiet: true });
    if (was !== net) {
      if (S.current && S.current.net !== net) startDraft({ keep: true });
      const field = $("inv-address"),
        typed = field.value.trim(),
        otherSaved = store.get(KEYS.addr(was), "");
      if (!S.current && (!typed || typed === otherSaved))
        field.value = store.get(KEYS.addr(net), "") || "";
      if (!silent)
        toast(
          net === "main"
            ? "Mainnet: real ZEC."
            : "Testnet: TAZ for testing only.",
        );
    }
    syncUnitUI();
    renderChips();
    refreshCounts();
    if (!S.current) updateDraft();
    if (S.tab === "batch") updateBatch();
    if (S.tab === "invoices") renderHistory();
    if (S.tab === "inspect") updateInspect();
  }

  /* ============================================================ invoice editor */

  let setUnitSeg = () => {};
  let pvQR = null;

  function syncUnitUI(cur = settings.currency) {
    const fiat = S.unit === "fiat";
    setUnitSeg(S.unit);
    $("inv-unit-fiat").textContent = cur;
    $("inv-currency").hidden = !fiat;
    $("inv-currency").value = cur;
    $("inv-unit-label").textContent = fiat ? cur : coinOf(S.net);
  }

  function setUnit(unit, { quiet } = {}) {
    if (unit === S.unit) return;
    const amt = $("inv-amount"),
      raw = amt.value.trim();
    if (quiet) amt.value = "";
    else if (raw) {
      if (unit === "fiat" && S.rates) {
        const a = Z.parseAmount(raw.replace(",", ".")),
          rate = S.rates[settings.currency.toLowerCase()];
        amt.value =
          a.ok && rate ? ((Number(a.zats) / 1e8) * rate).toFixed(2) : "";
      } else if (unit === "coin" && S.quote && S.quote.zats)
        amt.value = Z.formatAmount(S.quote.zats);
      else amt.value = "";
    }
    S.unit = unit;
    S.quote = null;
    syncUnitUI();
    renderChips();
    renderQuote();
    if (unit === "fiat") requestQuote();
    updateDraft();
  }

  function renderChips() {
    const fiat = S.unit === "fiat",
      scale = CHIP_SCALE[settings.currency] || 1;
    const vals = fiat
      ? [5, 10, 20, 50, 100].map((v) => String(v * scale))
      : ["0.01", "0.05", "0.1", "0.5", "1"];
    $("inv-chips").replaceChildren(
      ...vals.map((v) =>
        el("button", {
          type: "button",
          class: "chip",
          text: fiat
            ? fmtFiat(+v, settings.currency, true)
            : `${v} ${coinOf(S.net)}`,
          onclick: () => {
            $("inv-amount").value = v;
            onAmountInput();
          },
        }),
      ),
    );
  }

  const normFiat = (raw) => raw.replace(",", ".");
  const FIAT_RE = /^\d{1,12}([.,]\d{1,2})?$/;

  function readDraft() {
    const v = (id) => $(id).value.trim();
    return {
      address: v("inv-address"),
      amountRaw: v("inv-amount"),
      id: v("inv-id"),
      label: v("inv-label"),
      message: v("inv-message"),
      note: v("inv-note"),
    };
  }

  function evaluateDraft() {
    const d = readDraft(),
      ev = { d, errors: {} };
    ev.addr = d.address ? Z.checkPayTo(d.address, S.net) : null;
    if (!d.address)
      ev.errors.address = "Add the Unified Address you want to be paid at.";
    else if (!ev.addr.ok) ev.errors.address = ev.addr.error;

    if (S.unit === "coin") {
      const a = Z.parseAmount(
        d.amountRaw.replace(/\s/g, "").replace(/^(\d+),(\d+)$/, "$1.$2"),
      );
      if (!d.amountRaw) ev.errors.amount = "Enter an amount.";
      else if (!a.ok) ev.errors.amount = a.error;
      else if (a.zats === 0n)
        ev.errors.amount = "The amount must be more than zero.";
      else ev.zats = a.zats;
    } else {
      const q = S.quote;
      if (!d.amountRaw) ev.errors.amount = "Enter a price.";
      else if (!FIAT_RE.test(d.amountRaw) || !(+normFiat(d.amountRaw) > 0))
        ev.errors.amount = "Enter a price, with up to 2 decimal places.";
      else if (q && q.error) ev.errors.amount = q.error;
      else if (
        !q ||
        q.loading ||
        q.fiat !== normFiat(d.amountRaw) ||
        q.cur !== settings.currency
      ) {
        ev.errors.amount = "Fetching the live rate…";
        ev.amountPending = true;
      } else if (Date.now() >= q.expires) {
        ev.errors.amount = "The price quote has expired.";
        ev.quoteExpired = true;
      } else ev.zats = q.zats;
    }

    if (!d.id)
      ev.errors.id =
        "An invoice ID is required: it is how you match the payment.";
    else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/.test(d.id))
      ev.errors.id = "Use 2–32 letters, digits, dots, dashes or underscores.";
    else if (Inv.get(d.id))
      ev.errors.id = "A saved invoice already uses this ID.";

    /* Unique amount: add the invoice's tag (1–999 zatoshis) so the exact amount identifies it.
       A price that already uses those last three decimals identifies the invoice on its own,
       and is charged exactly as typed. */
    if (settings.uniqueAmounts && ev.zats != null && !ev.errors.id) {
      if (Z.hasTag(ev.zats)) ev.precise = true;
      else {
        ev.tag = Z.amountTag(d.id);
        ev.zats += ev.tag;
      }
    }

    ev.memo = [d.id, d.note].filter(Boolean).join(" · ");
    const m = Z.encodeMemo(ev.memo);
    ev.memoBytes = m.length;
    if (!m.ok) ev.errors.note = m.error;

    ev.ok = !Object.keys(ev.errors).length && ev.zats != null;
    if (ev.ok)
      ev.uri = Z.zip321.render([
        {
          address: ev.addr.value,
          zats: ev.zats,
          memo: m.bytes,
          label: d.label || null,
          message: d.message || null,
        },
      ]);
    return ev;
  }

  function renderAddressStatus(statusId, inputId, raw, res, showErrors) {
    if (!raw) {
      setInvalid(inputId, !!showErrors);
      return setStatus(
        statusId,
        showErrors ? "error" : "",
        showErrors
          ? "Add the Unified Address you want to be paid at."
          : `Paste the Unified Address from your wallet's Receive screen (starts with ${Z.NETS[S.net].uaPrefix}).`,
      );
    }
    if (res && res.ok) {
      setInvalid(inputId, false);
      const info = res.info,
        demo = Z.isDemoAddress(info);
      const body = el(
        "div",
        { class: "status-body" },
        el("span", {
          text: demo
            ? "Valid demo address. No one owns it and wallets will refuse to pay it."
            : `Valid ${info.revision === 2 ? "revision 2 " : ""}Unified Address`,
        }),
        el(
          "span",
          { class: "tags" },
          info.receivers.map((r) =>
            el("span", {
              class: "tag" + (/Orchard|Sapling/.test(r) ? " tag-accent" : ""),
              text: r,
            }),
          ),
          demo ? el("span", { class: "tag tag-warn", text: "Demo" }) : null,
        ),
      );
      return setStatus(statusId, demo ? "warn" : "ok", body);
    }
    if (!showErrors) {
      setInvalid(inputId, false);
      return setStatus(statusId, "", "Checking… paste the full address.");
    }
    setInvalid(inputId, true);
    const body = el("span", { text: res.error + " " });
    if (res.mismatch && Z.NETS[res.detected])
      body.append(
        el("button", {
          type: "button",
          class: "link-btn",
          text: `Switch to ${Z.NETS[res.detected].name}`,
          onclick: () => setNetwork(res.detected),
        }),
      );
    setStatus(statusId, "error", body);
  }

  function firstProblem(ev) {
    const e = ev.errors;
    if (!ev.d.address) return "Add your receiving address";
    if (e.address) return "Check the address";
    if (ev.amountPending) return "Fetching the live rate…";
    if (ev.quoteExpired) return "The price quote expired";
    if (!ev.d.amountRaw) return "Enter an amount";
    if (e.amount) return "Check the amount";
    if (e.id) return "Check the invoice ID";
    if (e.note) return "The memo is too long";
    return "Complete the form";
  }

  const qrLabel = (zats, addr, net) =>
    `QR code: pay ${Z.formatAmount(zats)} ${coinOf(net)} to ${short(addr, 10, 6)}`;

  function fiatHint(zats) {
    if (S.unit === "fiat") {
      const q = S.quote;
      return q && q.zats && !S.current
        ? `= ${Z.formatAmount(zats != null ? zats : q.zats)} ${coinOf(S.net)}`
        : "";
    }
    const rate =
      S.net === "main" && S.rates && S.rates[settings.currency.toLowerCase()];
    return rate && zats
      ? `≈ ${fmtFiat((Number(zats) / 1e8) * rate, settings.currency)}`
      : "";
  }

  function updateDraft() {
    if (S.current) return;
    const ev = evaluateDraft(),
      d = ev.d,
      e = ev.errors;
    const showAddr =
      S.touched.has("address") || S.submitted || d.address.length > 40;
    renderAddressStatus(
      "inv-address-status",
      "inv-address",
      d.address,
      ev.addr,
      (showAddr && !!d.address) || S.submitted,
    );

    const showAmt =
      !!e.amount && !ev.amountPending && (S.submitted || !!d.amountRaw);
    setInvalid("inv-amount", showAmt);
    if (ev.amountPending && d.amountRaw) setStatus("inv-amount-status", "", "");
    else if (showAmt) setStatus("inv-amount-status", "error", e.amount);
    else
      setStatus(
        "inv-amount-status",
        "",
        ev.tag && ev.zats != null
          ? `Includes a unique ${Z.formatAmount(ev.tag)} ${coinOf(S.net)} tag, so the payment can be matched even if a wallet drops the memo.`
          : ev.precise
            ? "No tag added: this exact amount already identifies the invoice."
            : "",
      );
    $("inv-fiat-hint").textContent = fiatHint(ev.zats);

    setInvalid("inv-id", !!e.id);
    setStatus("inv-id-status", e.id ? "error" : "", e.id || "");

    const meter = $("memo-bytes");
    meter.textContent = `${ev.memoBytes} / ${Z.MEMO_MAX} bytes`;
    meter.className =
      "byte-meter" +
      (ev.memoBytes > Z.MEMO_MAX
        ? " is-error"
        : ev.memoBytes > 450
          ? " is-warn"
          : "");
    $("memo-preview").textContent = ev.memo || "(empty memo)";
    setInvalid("inv-note", !!e.note);
    setStatus("inv-note-status", e.note ? "error" : "", e.note || "");

    /* preview */
    setBadge("inv-state", "Draft", "");
    $("pv-stamp").hidden = true;
    $("pv-expired").hidden = !ev.quoteExpired;
    $("pv-id").textContent = d.id || "–";
    const addrOk = ev.addr && ev.addr.ok;
    $("pv-addr").textContent = addrOk ? short(ev.addr.value, 10, 8) : "–";
    $("pv-addr").title = addrOk ? ev.addr.value : "";
    $("pv-amount").replaceChildren(
      ...(ev.zats != null ? amountNodes(ev.zats, ev.tag) : ["0"]),
    );
    const q = S.quote;
    $("pv-fiat").textContent =
      S.unit === "fiat" && q && q.rate
        ? `${fmtFiat(+q.fiat, q.cur)} · 1 ${coinOf(S.net)} = ${fmtFiat(q.rate, q.cur)}`
        : fiatHint(ev.zats);
    if (ev.ok) {
      densityTag(
        $("pv-density"),
        pvQR.show(ev.uri, qrLabel(ev.zats, ev.addr.value, S.net)),
        ev.uri,
      );
      $("pv-uri").textContent = ev.uri;
      setBadge("pv-status", "Ready to share", "badge-ok");
    } else {
      pvQR.clear(firstProblem(ev));
      densityTag($("pv-density"), null);
      $("pv-uri").textContent = "zcash:…";
      setBadge(
        "pv-status",
        ev.quoteExpired ? "Quote expired" : "Waiting for details",
        ev.quoteExpired ? "badge-danger" : "",
      );
    }
    setShare({
      share: ev.ok,
      pos: ev.ok,
      print: ev.ok,
      paid: ev.ok,
      uri: ev.ok ? ev.uri : "",
    });
    $("pv-print").lastChild.textContent = "Print";
    $("pv-paid").lastChild.textContent = "Record payment";
    $("pv-pos").lastChild.textContent = "Show to customer";
  }

  function setShare({ share, pos, print, paid, uri }) {
    $("pv-copy-uri").disabled = $("pv-png").disabled = !share;
    $("pv-pos").disabled = !pos;
    $("pv-print").disabled = !print;
    $("pv-paid").disabled = !paid;
    setLink($("pv-open"), share ? uri : "");
  }

  /* Shows a saved invoice in the editor, locked. */
  function renderCurrent() {
    const r = S.current;
    if (!r) return;
    const st = statusInfo(r),
      zats = BigInt(r.zats),
      coin = coinOf(r.net),
      expired = isExpired(r),
      open = isOpen(r);
    $("inv-title").textContent = "Invoice " + r.id;
    setBadge("inv-state", st.label, st.cls);
    $("inv-locked").hidden = false;
    $("inv-fields").disabled = true;
    $("inv-actions").hidden = true;
    const req = requestOf(r);
    $("inv-locked-text").textContent = req.balance
      ? `Part-paid: ${fmtZ(receivedOf(r))} of ${fmtZ(zats)} ${coin} received. The QR code now asks only for the ${fmtZ(req.zats)} ${coin} balance.`
      : open
      ? "Saved. The details are locked so they always match the QR code your customer sees."
      : r.status === "void"
        ? "This invoice was voided. Its QR code should not be used."
        : `Recorded as ${st.label.toLowerCase()}${r.paidAt ? " on " + fmtDate(r.paidAt) : ""}.`;
    $$(".field-status", $("inv-form")).forEach((s) => {
      s.replaceChildren();
      s.className = "field-status";
    });
    $$("[aria-invalid]", $("inv-form")).forEach((i) =>
      i.setAttribute("aria-invalid", "false"),
    );
    $("inv-fiat-hint").textContent = "";
    $("inv-quote").hidden = true;

    setBadge("pv-status", st.label, st.cls);
    densityTag(
      $("pv-density"),
      pvQR.show(req.uri, qrLabel(req.zats, r.address, r.net)),
      req.uri,
    );
    const done =
      r.status === "paid" || r.status === "partial" || r.status === "void";
    $("pv-stamp").hidden = !done || req.balance;
    $("pv-stamp").classList.toggle("is-void", r.status === "void");
    $("pv-stamp")
      .querySelector("use")
      .setAttribute("href", r.status === "void" ? "#i-ban" : "#i-check");
    $("pv-stamp-text").textContent =
      r.status === "void"
        ? "VOID"
        : r.status === "partial"
          ? "PART-PAID"
          : "PAID";
    $("pv-expired").hidden = !expired;
    $("pv-amount").replaceChildren(...amountNodes(req.zats, req.tag));
    $("pv-fiat").textContent = req.balance
      ? `Balance due · ${fmtZ(receivedOf(r))} of ${fmtZ(zats)} ${coin} received`
      : r.fiat
        ? `${fmtFiat(+r.fiat.value, r.fiat.cur)} · 1 ${coin} = ${fmtFiat(r.fiat.rate, r.fiat.cur)}`
        : "";
    $("pv-id").textContent = r.id;
    $("pv-addr").textContent = short(r.address, 10, 8);
    $("pv-addr").title = r.address;
    $("pv-uri").textContent = req.uri;
    const live = r.status === "pending" && !expired;
    setShare({
      share: live || req.balance,
      pos: live || req.balance,
      print: r.status !== "void",
      paid: r.status !== "void",
      uri: live || req.balance ? req.uri : "",
    });
    $("pv-pos").lastChild.textContent = req.balance ? "Request balance" : "Show to customer";
    $("pv-print").lastChild.textContent = done && !req.balance ? "Receipt" : "Print";
    $("pv-paid").lastChild.textContent =
      r.status === "paid" ? "Edit payment" : "Record payment";
  }

  function fillForm(r) {
    S.unit = r.fiat ? "fiat" : "coin";
    syncUnitUI(r.fiat ? r.fiat.cur : settings.currency);
    $("inv-address").value = r.address;
    $("inv-amount").value = r.fiat ? r.fiat.value : fmtZ(r.zats);
    $("inv-id").value = r.id;
    $("inv-label").value = r.label || "";
    $("inv-message").value = r.message || "";
    $("inv-note").value = r.note || "";
    $("inv-more").open = !!(r.label || r.message || r.note);
    $("memo-preview").textContent = r.memo || "(empty memo)";
    $("memo-bytes").textContent =
      `${Z.encodeMemo(r.memo || "").length} / ${Z.MEMO_MAX} bytes`;
  }

  function openInvoice(id) {
    const r = Inv.get(id);
    if (!r) return toast("That invoice no longer exists.", "error");
    if (r.net !== S.net) setNetwork(r.net, { silent: true });
    S.current = r;
    S.quote = null;
    fillForm(r);
    renderChips();
    renderCurrent();
    showTab("invoice");
  }

  function startDraft({ keep = false } = {}) {
    S.current = null;
    S.submitted = false;
    S.touched.clear();
    S.quote = null;
    $("inv-title").textContent = "New invoice";
    $("inv-locked").hidden = true;
    $("inv-fields").disabled = false;
    $("inv-actions").hidden = false;
    if (!keep) {
      ["inv-amount", "inv-label", "inv-message", "inv-note"].forEach((id) => {
        $(id).value = "";
      });
      $("inv-more").open = false;
      if (!$("inv-address").value.trim())
        $("inv-address").value = store.get(KEYS.addr(S.net), "") || "";
      if (S.unit === "fiat" && S.net === "test") S.unit = "coin";
    }
    $("inv-id").value = newInvoiceId();
    syncUnitUI();
    renderChips();
    renderQuote();
    if (keep && S.unit === "fiat") requestQuote();
    updateDraft();
  }

  function rememberAddress(addr) {
    if ($("inv-remember").checked) store.set(KEYS.addr(S.net), addr);
  }

  /** Saves the current draft and locks it. Returns the saved record, or null if invalid. */
  function issueDraft() {
    if (S.current) return S.current;
    const ev = evaluateDraft();
    if (!ev.ok) {
      S.submitted = true;
      updateDraft();
      const first = ["inv-address", "inv-amount", "inv-id", "inv-note"].find(
        (id) => $(id).getAttribute("aria-invalid") === "true",
      );
      if (first === "inv-note") $("inv-more").open = true;
      if (first) $(first).focus();
      toast(
        ev.quoteExpired
          ? "The price quote expired. Refresh it first."
          : ev.amountPending
            ? "Still fetching the exchange rate. Try again in a moment."
            : "Fix the highlighted fields first.",
        "error",
      );
      return null;
    }
    const d = ev.d,
      q = S.unit === "fiat" ? S.quote : null,
      now = nowIso();
    const rec = {
      id: d.id,
      net: S.net,
      address: ev.addr.value,
      zats: String(ev.zats),
      label: d.label,
      message: d.message,
      note: d.note,
      memo: ev.memo,
      uri: ev.uri,
      amountTag: ev.tag != null ? String(ev.tag) : null,
      fiat: q
        ? {
            cur: q.cur,
            value: q.fiat,
            rate: q.rate,
            at: new Date(q.at).toISOString(),
          }
        : null,
      expiresAt: q ? new Date(q.expires).toISOString() : null,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      paidAt: null,
      txid: "",
      receivedZats: null,
    };
    rememberAddress(rec.address);
    S.current = rec;
    Inv.put(rec);
    toast(`Invoice ${rec.id} saved.`, "success");
    return S.current;
  }

  function withInvoice(fn) {
    const r = S.current || issueDraft();
    if (r && fn) fn(r);
    return r;
  }

  /* ============================================================ fiat quotes */

  async function getRate(cur, force) {
    if (force || !S.rates || Date.now() - S.ratesAt > 60000) {
      const ctrl = new AbortController(),
        timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(
          RATE_URL + CURRENCIES.map((c) => c.toLowerCase()).join(","),
          {
            signal: ctrl.signal,
            credentials: "omit",
            referrerPolicy: "no-referrer",
            cache: "no-store",
          },
        );
        if (!res.ok) throw new Error("HTTP " + res.status);
        const j = await res.json();
        if (!j || !j.zcash) throw new Error("Unexpected response");
        S.rates = j.zcash;
        S.ratesAt = Date.now();
      } finally {
        clearTimeout(timer);
      }
    }
    const rate = S.rates[cur.toLowerCase()];
    if (!(rate > 0)) throw new Error("No rate for " + cur);
    return rate;
  }

  function makeQuote(fiat, cur, rate) {
    const units = Math.max(1, Math.round((+fiat / rate) * 1e5)); // rounded to 0.00001 ZEC
    const at = Date.now();
    return {
      fiat,
      cur,
      rate,
      zats: BigInt(units) * 1000n,
      at,
      expires: at + settings.lockMin * 60000,
    };
  }

  let quoteSeq = 0;
  async function requestQuote(force) {
    if (S.unit !== "fiat" || S.current) return;
    const raw = $("inv-amount").value.trim(),
      seq = ++quoteSeq;
    if (!raw || !FIAT_RE.test(raw) || !(+normFiat(raw) > 0)) {
      S.quote = null;
      renderQuote();
      updateDraft();
      return;
    }
    const fiat = normFiat(raw),
      cur = settings.currency;
    S.quote = { loading: true };
    renderQuote();
    updateDraft();
    try {
      const rate = await getRate(cur, force);
      if (seq !== quoteSeq) return;
      S.quote = makeQuote(fiat, cur, rate);
    } catch (e) {
      if (seq !== quoteSeq) return;
      S.quote = {
        error: `Live rate unavailable (offline, blocked or rate-limited). Retry, or price in ${coinOf(S.net)}.`,
      };
    }
    renderQuote();
    updateDraft();
  }
  const requestQuoteSoon = debounce(requestQuote, 450);

  function renderQuote() {
    const box = $("inv-quote"),
      q = S.quote;
    box.hidden = !(S.unit === "fiat" && !S.current && q);
    if (box.hidden) return;
    box.classList.toggle("is-error", !!q.error);
    box.classList.remove("is-low");
    $("quote-refresh").hidden = !!q.loading;
    $("quote-refresh").textContent = q.error ? "Retry" : "Refresh rate";
    if (q.loading || q.error) {
      $("quote-text").textContent = q.loading
        ? "Fetching the live rate…"
        : q.error;
      $("quote-bar").style.width = "0%";
      return;
    }
    tick();
  }

  async function refreshInvoiceQuote(id) {
    const r = Inv.get(id);
    if (!r || !r.fiat || r.status !== "pending") return; // a part-paid balance stays fixed in ZEC
    try {
      const rate = await getRate(r.fiat.cur, true),
        q = makeQuote(r.fiat.value, r.fiat.cur, rate);
      if (r.amountTag) q.zats += BigInt(r.amountTag);
      const uri = Z.zip321.render([
        {
          address: r.address,
          zats: q.zats,
          memo: Z.encodeMemo(r.memo).bytes,
          label: r.label || null,
          message: r.message || null,
        },
      ]);
      Inv.patch(id, (x) => {
        x.zats = String(q.zats);
        x.uri = uri;
        x.fiat.rate = rate;
        x.fiat.at = new Date(q.at).toISOString();
        x.expiresAt = new Date(q.expires).toISOString();
      });
      toast(
        `New price: ${Z.formatAmount(q.zats)} ${coinOf(r.net)}, held for ${settings.lockMin} minutes.`,
        "success",
      );
    } catch (e) {
      toast(
        "Could not fetch a live rate. Check your connection and try again.",
        "error",
      );
    }
  }

  /* Once a second: countdowns for the draft quote, the open invoice and the customer screen. */
  function tick() {
    const q = S.quote;
    if (q && q.rate && S.unit === "fiat" && !S.current) {
      const left = Math.max(0, q.expires - Date.now());
      $("quote-text").replaceChildren(
        el(
          "span",
          null,
          `1 ${coinOf(S.net)} = `,
          el("strong", { text: fmtFiat(q.rate, q.cur) }),
          " (CoinGecko, advisory)",
        ),
        el(
          "span",
          null,
          left
            ? ["Price held for ", el("strong", { text: fmtLeft(left) })]
            : el("strong", { text: "Quote expired" }),
        ),
      );
      $("quote-bar").style.width = (100 * left) / (q.expires - q.at) + "%";
      $("inv-quote").classList.toggle("is-low", left < 60000);
      if (!left && !q.expiredShown) {
        q.expiredShown = true;
        updateDraft();
      }
    }
    if (S.current && S.current.expiresAt && S.current.status === "pending") {
      const expired = isExpired(S.current);
      if (expired !== !$("pv-expired").hidden) {
        renderCurrent();
        refreshCounts();
      }
    }
    if (S.posId) renderPosTimer();
  }

  /* ============================================================ payment recording */

  /* On a part-paid invoice a payment is added to what was already received; otherwise it sets
     the amount received. zats == null means "the rest of the amount due". */
  function applyPayment(id, { zats, txid, via }) {
    let status = null;
    Inv.patch(id, (x) => {
      const due = BigInt(x.zats),
        adding = x.status === "partial",
        prior = adding ? receivedOf(x) : 0n,
        got = zats == null ? due - prior : zats,
        total = prior + got;
      x.payments = [
        ...(adding ? paymentsOf(x) : []),
        { zats: String(got), txid: txid || "", at: nowIso(), via },
      ];
      x.receivedZats = String(total);
      x.status = total >= due ? "paid" : "partial";
      x.paidAt = nowIso();
      if (txid) x.txid = txid;
      x.paidVia = via;
      status = x.status;
    });
    return status;
  }
  const PAYMENT_FIELDS = ["status", "paidAt", "receivedZats", "paidVia", "txid", "payments"];
  function paymentState(id) {
    const r = Inv.get(id);
    return r ? Object.fromEntries(PAYMENT_FIELDS.map((k) => [k, r[k] == null ? null : r[k]])) : null;
  }
  function restorePayment(id, before) {
    if (before) Inv.patch(id, (x) => Object.assign(x, before));
  }

  function markPaid(id, opts) {
    const before = paymentState(id),
      status = applyPayment(id, opts);
    if (!status) return;
    const r = Inv.get(id);
    toast(
      status === "paid"
        ? `${id} marked as paid.`
        : `${id} recorded as part-paid: ${fmtZ(balanceOf(r))} ${coinOf(r.net)} still due.`,
      "success",
      { label: "Undo", run: () => restorePayment(id, before) },
    );
  }

  function dlRows(rows) {
    return rows
      .filter(Boolean)
      .flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]);
  }

  function openPaidDialog(id) {
    const r = Inv.get(id);
    if (!r) return;
    const coin = coinOf(r.net),
      due = BigInt(r.zats),
      partial = r.status === "partial";
    $("paid-summary").replaceChildren(
      ...dlRows([
        ["Invoice", r.id],
        ["Amount due", `${Z.formatAmount(due)} ${coin}`],
        partial && ["Received so far", `${fmtZ(receivedOf(r))} ${coin}`],
        partial && ["Balance due", `${fmtZ(balanceOf(r))} ${coin}`],
        r.label && ["Item", r.label],
        ["Created", fmtDate(r.createdAt)],
      ]),
    );
    $$(".coin", $("dlg-paid")).forEach((e) => {
      e.textContent = coin;
    });
    $("paid-amount").value = Z.formatAmount(
      partial ? balanceOf(r) : r.receivedZats ? BigInt(r.receivedZats) : due,
    );
    $("paid-txid").value = partial ? "" : r.txid || "";
    setInvalid("paid-amount", false);
    setInvalid("paid-txid", false);
    setStatus(
      "paid-amount-status",
      "",
      partial
        ? `This payment is added to the ${fmtZ(receivedOf(r))} ${coin} already received. Less than the balance keeps the invoice part-paid.`
        : "Less than the amount due records the invoice as part-paid.",
    );
    setStatus(
      "paid-txid-status",
      "",
      "Lets you look the payment up later. Zectill does not contact the network.",
    );
    const dlg = $("dlg-paid");
    dlg.dataset.id = id;
    dlg.showModal();
  }

  /* ============================================================ merchant PIN */

  /* Locks the customer screen against the customer, not against the device's owner: only a
     salted SHA-256 hash is stored, wrong tries pause the keypad, and clearing the site's data
     removes the PIN. The keypad is reshuffled every time so finger positions reveal nothing. */
  const Pin = {
    get() {
      const p = store.get(KEYS.pin, null);
      return p && p.salt && p.hash && p.len ? p : null;
    },
    hash: (pin, salt) =>
      Z.bytes.toHex(Z.hash.sha256(new TextEncoder().encode(salt + ":" + pin))),
    set(pin) {
      const salt = Z.bytes.toHex(crypto.getRandomValues(new Uint8Array(16)));
      store.set(KEYS.pin, { salt, hash: Pin.hash(pin, salt), len: pin.length });
      store.remove(KEYS.pinFails);
    },
    clear() {
      store.remove(KEYS.pin);
      store.remove(KEYS.pinFails);
    },
    check(pin) {
      const p = Pin.get();
      return !!p && Pin.hash(pin, p.salt) === p.hash;
    },
    waitMs() {
      const f = store.get(KEYS.pinFails, null);
      return f && f.until > Date.now() ? f.until - Date.now() : 0;
    },
    /* After 5 wrong tries the keypad pauses for 30 s, doubling on each further miss. */
    fail() {
      const f = store.get(KEYS.pinFails, { count: 0, until: 0 });
      f.count++;
      if (f.count >= 5) f.until = Date.now() + 30000 * 2 ** Math.min(f.count - 5, 5);
      store.set(KEYS.pinFails, f);
      return f;
    },
  };
  const pinOn = () => !!Pin.get();
  const secs = (ms) => `${Math.ceil(ms / 1000)} s`;

  function shuffledDigits() {
    const d = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const r = crypto.getRandomValues(new Uint32Array(10));
    for (let i = 9; i > 0; i--) {
      const j = r[i] % (i + 1);
      [d[i], d[j]] = [d[j], d[i]];
    }
    return d.map(String);
  }

  /* Opens the PIN keypad. With `length`, it checks as soon as that many digits are in;
     otherwise the merchant presses the submit button. `onSubmit(digits)` returns { ok } or
     { msg } (shown, then the keypad clears and reshuffles). Resolves to the digits, or null. */
  function pinPad({ title, sub, length, submitLabel, onSubmit, msg = "", forgot = false }) {
    return new Promise((resolve) => {
      const d = $("dlg-pin"), pad = $("pin-pad"), ok = $("pin-ok"), max = length || 8;
      let digits = "", busy = false, finished = false;
      $("pin-title").textContent = title;
      $("pin-sub").textContent = sub;
      $("pin-msg").textContent = msg;
      $("pin-forgot").hidden = !forgot;
      ok.hidden = !!length;
      ok.textContent = submitLabel || "Continue";
      const dots = () => {
        const n = length || Math.max(4, digits.length);
        $("pin-dots").replaceChildren(
          ...Array.from({ length: n }, (_, i) => el("span", { class: "pin-dot" + (i < digits.length ? " is-on" : "") })),
        );
        $("pin-dots").setAttribute("aria-label", plural(digits.length, "digit") + " entered");
        ok.disabled = digits.length < 4;
      };
      const key = (label, run, cls) => el("button", { type: "button", class: "pin-key" + (cls ? " " + cls : ""), onclick: run }, label);
      const shuffle = () => {
        const n = shuffledDigits().map((v) => key(v, () => press(v)));
        pad.replaceChildren(
          ...n.slice(0, 9),
          key("Clear", () => { digits = ""; dots(); }, "pin-key-small"),
          n[9],
          key(icon("backspace"), () => { digits = digits.slice(0, -1); dots(); }, "pin-key-small"),
        );
        pad.lastElementChild.setAttribute("aria-label", "Delete last digit");
      };
      const submit = async () => {
        if (busy || digits.length < 4) return;
        busy = true;
        const r = await onSubmit(digits);
        busy = false;
        if (r.ok) {
          finished = true;
          d.close();
          resolve(digits);
          return;
        }
        $("pin-msg").textContent = r.msg;
        const body = $("pin-body");
        body.classList.remove("is-wrong");
        void body.offsetWidth;
        body.classList.add("is-wrong");
        digits = "";
        dots();
        shuffle();
      };
      const press = (v) => {
        if (digits.length >= max) return;
        digits += v;
        dots();
        if (length && digits.length === length) submit();
      };
      ok.onclick = submit;
      d.onkeydown = (e) => {
        if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); }
        else if (e.key === "Backspace") { e.preventDefault(); digits = digits.slice(0, -1); dots(); }
        else if (e.key === "Enter") { e.preventDefault(); submit(); }
      };
      d.onclose = () => {
        if (d.open || finished) return;
        finished = true;
        resolve(null);
      };
      dots();
      shuffle();
      d.showModal();
      pad.firstElementChild.focus();
    });
  }

  function verifyPin(title, sub) {
    const wait = Pin.waitMs();
    return pinPad({
      title,
      sub,
      length: Pin.get().len,
      forgot: true,
      msg: wait ? `Too many wrong tries. Try again in ${secs(wait)}.` : "",
      onSubmit: (digits) => {
        const w = Pin.waitMs();
        if (w) return { msg: `Too many wrong tries. Try again in ${secs(w)}.` };
        if (Pin.check(digits)) {
          store.remove(KEYS.pinFails);
          return { ok: true };
        }
        const f = Pin.fail();
        return {
          msg: f.until > Date.now()
            ? `Wrong PIN. The keypad is paused for ${secs(f.until - Date.now())}.`
            : `Wrong PIN. ${5 - f.count} ${5 - f.count === 1 ? "try" : "tries"} left before a pause.`,
        };
      },
    }).then((v) => v !== null);
  }

  async function setupPin() {
    if (pinOn() && !(await verifyPin("Enter your current PIN", "You need it before choosing a new one."))) return;
    const first = await pinPad({
      title: "Choose a merchant PIN",
      sub: "4 to 8 digits. You'll enter it to confirm payments and to leave the customer screen.",
      submitLabel: "Continue",
      onSubmit: () => ({ ok: true }),
    });
    if (!first) return;
    const again = await pinPad({
      title: "Enter the PIN again",
      sub: "To make sure it's what you meant.",
      length: first.length,
      onSubmit: (d) => (d === first ? { ok: true } : { msg: "Those PINs don't match. Enter it again." }),
    });
    if (!again) return;
    Pin.set(first);
    renderPinSetting();
    toast("Merchant PIN set. Export a backup in case you ever forget it.", "success");
  }

  async function removePin() {
    if (!(await verifyPin("Enter your PIN", "You need it to remove the PIN."))) return;
    Pin.clear();
    renderPinSetting();
    toast("Merchant PIN removed. The customer screen is back to press-and-hold.");
  }

  function renderPinSetting() {
    const on = pinOn();
    $("set-pin-status").textContent = on
      ? "On. Confirming a payment or leaving the customer screen needs the PIN."
      : "Off. The customer screen uses press-and-hold to confirm.";
    $("set-pin").lastChild.textContent = on ? "Change PIN" : "Set PIN";
    $("set-pin-off").hidden = !on;
  }

  /* With a PIN set, one correct entry unlocks the open customer screen until it closes. */
  async function posGuard(title, sub) {
    if (!pinOn() || S.posUnlocked) return true;
    const ok = await verifyPin(title, sub);
    if (ok) S.posUnlocked = true;
    return ok;
  }
  async function leavePOS(after) {
    if (!(await posGuard("Merchant PIN", "Enter the PIN to leave the customer screen."))) return;
    closePOS();
    if (after) after();
  }

  /* ============================================================ customer screen */

  const BACKGROUND = [
    "#net-banner",
    ".topbar",
    ".tabbar",
    "#main",
    ".site-footer",
  ];

  function openPOS(rec) {
    S.posId = rec.id;
    S.posReturn = document.activeElement;
    S.posUnlocked = false;
    const pos = $("pos"),
      paid = $("pos-paid");
    /* With a PIN, a reload reopens this screen instead of revealing the merchant view. */
    if (pinOn()) store.set(KEYS.posLock, rec.id);
    paid.classList.toggle("btn-hold", !pinOn());
    paid.lastChild.textContent = pinOn() ? "Payment received" : "Hold: payment received";
    paid.title = pinOn() ? "Needs the merchant PIN" : "Press and hold to confirm";
    $("pos-success").hidden = true;
    $("toasts").replaceChildren(); // merchant notices do not belong on the customer's screen
    renderPOS();
    pos.hidden = false;
    document.body.classList.add("pos-open");
    BACKGROUND.forEach((s) => {
      const n = document.querySelector(s);
      if (n) n.inert = true;
    });
    if (pos.requestFullscreen && matchMedia("(pointer: coarse)").matches)
      pos.requestFullscreen().catch(() => {});
    if (navigator.wakeLock)
      navigator.wakeLock
        .request("screen")
        .then((l) => {
          S.wakeLock = l;
        })
        .catch(() => {});
    $("pos-close").focus();
  }

  function closePOS() {
    if (!S.posId) return;
    S.posId = null;
    S.posUnlocked = false;
    store.remove(KEYS.posLock);
    $("pos").hidden = true;
    document.body.classList.remove("pos-open");
    BACKGROUND.forEach((s) => {
      const n = document.querySelector(s);
      if (n) n.inert = false;
    });
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (S.wakeLock) {
      S.wakeLock.release().catch(() => {});
      S.wakeLock = null;
    }
    if (S.posReturn && S.posReturn.focus) S.posReturn.focus();
  }

  function renderPOS() {
    const r = Inv.get(S.posId);
    if (!r) return closePOS();
    const req = requestOf(r),
      zats = req.zats,
      coin = coinOf(r.net);
    $("pos-business").textContent = settings.business || "Pay with Zcash";
    try {
      $("pos-qr").replaceChildren(QR.canvas(req.uri, 960));
    } catch (e) {
      $("pos-qr").replaceChildren(
        el("p", { text: "QR unavailable: use Copy link." }),
      );
    }
    $("pos-qr").setAttribute("aria-label", qrLabel(zats, r.address, r.net));
    $("pos-expired").hidden = !isExpired(r);
    $("pos-amount").replaceChildren(
      ...amountNodes(zats, req.tag),
      el("span", { class: "unit", text: coin }),
    );
    $("pos-fiat").textContent = req.balance
      ? `Balance due · ${fmtZ(receivedOf(r))} ${coin} already paid`
      : r.fiat
        ? `≈ ${fmtFiat(+r.fiat.value, r.fiat.cur)}`
        : "";
    $("pos-label").textContent = r.label || "";
    $("pos-meta").textContent = r.id + (r.net === "test" ? " · TESTNET" : "");
    $("pos-paid").hidden = $("pos-other").hidden = !isOpen(r);
    if (r.status === "paid" && $("pos-success").hidden) {
      $("pos-success-text").textContent =
        `${Z.formatAmount(BigInt(r.receivedZats || r.zats))} ${coin} received`;
      $("pos-success").hidden = false;
      $("pos-next").focus();
    }
    renderPosTimer();
  }

  function renderPosTimer() {
    const r = Inv.get(S.posId),
      t = $("pos-timer");
    if (!r || !r.expiresAt || r.status !== "pending") {
      t.hidden = true;
      return;
    }
    const left = Date.parse(r.expiresAt) - Date.now();
    t.hidden = false;
    t.classList.toggle("is-low", left < 60000);
    t.lastElementChild.textContent =
      left > 0 ? `Price held for ${fmtLeft(left)}` : "Price expired";
    if (left <= 0 && $("pos-expired").hidden) renderPOS();
  }

  /* ============================================================ history */

  let setFilterSeg = () => {};

  function renderHistory() {
    const all = Inv.all().sort((a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt)),
    );
    renderStats(all);
    const q = S.search.trim().toLowerCase();
    const list = all.filter((r) => {
      if (S.filter === "open" && !isOpen(r)) return false;
      if (S.filter === "paid" && r.status !== "paid") return false;
      if (S.filter === "void" && r.status !== "void") return false;
      return (
        !q ||
        [r.id, r.label, r.message, r.memo, r.txid, r.address].some(
          (v) => v && String(v).toLowerCase().includes(q),
        )
      );
    });
    $("h-list").replaceChildren(...list.map(historyRow));
    $("h-list").hidden = !list.length;
    const empty = $("h-empty");
    empty.hidden = !!list.length;
    if (!list.length) {
      const none = !all.length;
      empty.replaceChildren(
        el("div", { class: "empty-icon" }, icon(none ? "receipt" : "search")),
        el("h3", { text: none ? "No invoices yet" : "Nothing matches" }),
        el("p", {
          text: none
            ? "Invoices you save, share or show to a customer appear here with their status, so you can match payments and export your records."
            : "Try a different search or status filter.",
        }),
        el(
          "div",
          { class: "row-wrap" },
          none
            ? el(
                "button",
                {
                  type: "button",
                  class: "btn btn-primary",
                  onclick: () => {
                    startDraft();
                    showTab("invoice");
                    $("inv-amount").focus();
                  },
                },
                icon("plus"),
                "Create an invoice",
              )
            : el(
                "button",
                {
                  type: "button",
                  class: "btn btn-secondary",
                  onclick: () => {
                    S.search = "";
                    $("h-search").value = "";
                    S.filter = "all";
                    setFilterSeg("all");
                    renderHistory();
                  },
                },
                "Clear filters",
              ),
        ),
      );
    }
  }

  function renderStats(all) {
    const coin = coinOf(S.net),
      mine = all.filter((r) => r.net === S.net);
    const sum = (arr, f) => arr.reduce((s, r) => s + BigInt(f(r)), 0n);
    const open = mine.filter((r) => isOpen(r) && !isExpired(r));
    const paid = mine.filter(
      (r) => r.status === "paid" || r.status === "partial",
    );
    const today = new Date().toDateString();
    const todays = paid.filter(
      (r) => r.paidAt && new Date(r.paidAt).toDateString() === today,
    );
    const got = (r) => r.receivedZats || r.zats;
    const owed = (r) => {
      const left =
        BigInt(r.zats) -
        BigInt(r.status === "partial" && r.receivedZats ? r.receivedZats : 0);
      return left > 0n ? left : 0n;
    };
    const tile = (label, zats, sub) =>
      el(
        "div",
        { class: "stat" },
        el("div", { class: "stat-label", text: label }),
        el(
          "div",
          { class: "stat-value" },
          Z.formatAmount(zats),
          el("small", { text: coin }),
        ),
        el("div", { class: "stat-sub", text: sub }),
      );
    $("h-stats").replaceChildren(
      tile(
        "Awaiting payment",
        sum(open, owed),
        plural(open.length, "open invoice"),
      ),
      tile(
        "Collected",
        sum(paid, got),
        `from ${plural(paid.length, "invoice")}`,
      ),
      tile(
        "Collected today",
        sum(todays, got),
        todays.length
          ? plural(todays.length, "payment")
          : "No payments yet today",
      ),
    );
  }

  function historyRow(r) {
    const st = statusInfo(r),
      coin = coinOf(r.net),
      zats = BigInt(r.zats);
    const desc = [
      r.label || r.note || r.message || "No description",
      relTime(r.createdAt),
    ].join(" · ");
    const main = el(
      "button",
      { type: "button", class: "inv-main", onclick: () => openInvoice(r.id) },
      el(
        "span",
        { class: "inv-id" },
        r.id,
        r.net === "test"
          ? el("span", { class: "tag tag-warn", text: "Testnet" })
          : null,
      ),
      el("span", { class: "inv-desc", text: desc }),
    );
    const sub =
      r.status === "partial" && r.receivedZats
        ? `received ${fmtZ(r.receivedZats)} · ${fmtZ(balanceOf(r))} due`
        : r.fiat
          ? fmtFiat(+r.fiat.value, r.fiat.cur)
          : null;
    const actions = el("div", { class: "inv-actions" });
    if (isOpen(r))
      actions.append(
        el(
          "button",
          {
            type: "button",
            class: "btn btn-secondary btn-sm",
            "aria-label": `Record a payment for ${r.id}`,
            onclick: () => openPaidDialog(r.id),
          },
          icon("check"),
          "Record payment",
        ),
      );
    actions.append(rowMenu(r));
    return el(
      "li",
      { class: "inv-row" },
      main,
      el(
        "div",
        { class: "inv-amt" },
        el("strong", { text: `${Z.formatAmount(zats)} ${coin}` }),
        sub ? el("span", { text: sub }) : null,
      ),
      el("span", { class: "badge " + st.cls, text: st.label }),
      actions,
    );
  }

  function rowMenu(r) {
    const live = r.status === "pending" && !isExpired(r);
    const item = (ic, label, run, cls) =>
      el(
        "button",
        {
          type: "button",
          role: "menuitem",
          class: cls || null,
          onclick: (e) => {
            e.currentTarget.closest("details").open = false;
            run();
          },
        },
        icon(ic),
        label,
      );
    const items = [
      item("external", "Open", () => openInvoice(r.id)),
      live || r.status === "partial"
        ? item(
            "expand",
            r.status === "partial" ? "Request balance" : "Show to customer",
            () => openPOS(r),
          )
        : null,
      live || r.status === "partial"
        ? item(
            "link",
            r.status === "partial" ? "Copy balance link" : "Copy payment link",
            () => copyText(requestOf(r).uri, "Payment link copied."),
          )
        : null,
      r.status !== "void"
        ? item(
            "printer",
            r.status === "paid" ? "Print receipt" : "Print invoice",
            () => printInvoice(r),
          )
        : null,
      item("copy", "Duplicate as new", () => duplicateInvoice(r)),
      el("div", { class: "menu-sep", role: "separator" }),
      isOpen(r)
        ? item("ban", "Void", () => voidInvoice(r.id), "is-danger")
        : null,
      item("trash", "Delete", () => deleteInvoice(r.id), "is-danger"),
    ];
    return el(
      "details",
      { class: "menu" },
      el(
        "summary",
        {
          class: "btn btn-ghost btn-icon btn-sm",
          "aria-label": `More actions for ${r.id}`,
          title: "More actions",
        },
        icon("more"),
      ),
      el("div", { class: "menu-pop", role: "menu" }, items),
    );
  }

  function duplicateInvoice(r) {
    S.current = null;
    fillForm(r);
    if (r.net !== S.net) setNetwork(r.net, { silent: true });
    startDraft({ keep: true });
    showTab("invoice");
    toast("Copied into a new invoice with a fresh ID.");
  }

  async function voidInvoice(id) {
    const ok = await confirmDialog({
      title: `Void ${id}?`,
      body: "Voided invoices stay in your records but should no longer be paid. Anyone holding the QR code could still send funds to your address.",
      ok: "Void invoice",
      danger: true,
    });
    if (!ok) return;
    let prev;
    Inv.patch(id, (x) => {
      prev = x.status;
      x.status = "void";
    });
    toast(`${id} voided.`, "info", {
      label: "Undo",
      run: () =>
        Inv.patch(id, (x) => {
          x.status = prev;
        }),
    });
  }

  function deleteInvoice(id) {
    const r = Inv.remove(id);
    if (r)
      toast(`${id} deleted.`, "info", { label: "Undo", run: () => Inv.put(r) });
  }

  function exportCsv() {
    const all = Inv.all().sort((a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt)),
    );
    if (!all.length) return toast("No invoices to export yet.", "error");
    const cols = [
      ["id", (r) => r.id],
      ["status", (r) => statusInfo(r).label],
      ["network", (r) => r.net],
      ["amount", (r) => fmtZ(r.zats)],
      ["coin", (r) => coinOf(r.net)],
      ["received", (r) => (r.receivedZats ? fmtZ(r.receivedZats) : "")],
      ["fiat_amount", (r) => (r.fiat ? r.fiat.value : "")],
      ["fiat_currency", (r) => (r.fiat ? r.fiat.cur : "")],
      ["rate", (r) => (r.fiat ? r.fiat.rate : "")],
      ["item", (r) => r.label],
      ["message", (r) => r.message],
      ["memo", (r) => r.memo],
      ["created_at", (r) => r.createdAt],
      ["paid_at", (r) => r.paidAt],
      ["txid", (r) => r.txid],
      ["address", (r) => r.address],
      ["uri", (r) => r.uri],
    ];
    const esc = (v) => {
      let s = v == null ? "" : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const csv =
      "﻿" +
      [cols.map((c) => c[0]).join(",")]
        .concat(all.map((r) => cols.map((c) => esc(c[1](r))).join(",")))
        .join("\r\n");
    downloadBlob(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      `zectill-invoices-${nowIso().slice(0, 10)}.csv`,
    );
    toast(`Exported ${plural(all.length, "invoice")}.`, "success");
  }

  function printInvoice(r) {
    const coin = coinOf(r.net),
      zats = BigInt(r.zats),
      req = requestOf(r),
      paid = r.status === "paid";
    const rows = [
      ["Invoice", r.id],
      ["Date", fmtDate(r.createdAt)],
      r.label && ["Item", r.label],
      ["Amount", `${Z.formatAmount(zats)} ${coin}`],
      r.fiat && [
        "Price",
        `${fmtFiat(+r.fiat.value, r.fiat.cur)} (1 ${coin} = ${fmtFiat(r.fiat.rate, r.fiat.cur)})`,
      ],
      ["Network", Z.NETS[r.net].name],
      ["Status", statusInfo(r).label],
      r.paidAt && ["Paid on", fmtDate(r.paidAt)],
      r.receivedZats && ["Received", `${fmtZ(r.receivedZats)} ${coin}`],
      req.balance && ["Balance due", `${Z.formatAmount(req.zats)} ${coin}`],
      r.txid && ["Transaction", r.txid],
      r.message && ["Message", r.message],
      ["Pay to", r.address],
    ].filter(Boolean);
    const doc = el(
      "div",
      { class: "doc" },
      el(
        "div",
        { class: "doc-head" },
        el(
          "div",
          null,
          el("div", {
            class: "doc-business",
            text: settings.business || "Zectill",
          }),
          el("div", { class: "doc-sub", text: "Shielded Zcash payment" }),
        ),
        el("div", { class: "doc-title", text: paid ? "Receipt" : "Invoice" }),
      ),
      el(
        "div",
        { class: "doc-body" },
        el(
          "table",
          { class: "doc-table" },
          el(
            "tbody",
            null,
            rows.map(([k, v]) =>
              el("tr", null, el("th", { text: k }), el("td", { text: v })),
            ),
          ),
        ),
        paid
          ? null
          : el(
              "div",
              { class: "doc-qr" },
              qrImg(req.uri, req.balance ? "Balance payment QR code" : "Payment QR code"),
              el("div", {
                text: req.balance ? "Scan to pay the balance" : "Scan with any Zcash wallet",
              }),
            ),
      ),
      paid
        ? el("div", { class: "doc-stamp", text: "PAID" })
        : el("div", { class: "doc-uri", text: req.uri }),
      el("div", {
        class: "doc-foot",
        text: paid
          ? "Payment recorded by the merchant from their own wallet. Zectill does not verify payments on-chain."
          : "Generated locally with Zectill (ZIP-321). Your wallet shows the amount and memo before you approve.",
      }),
    );
    printNode(doc);
  }

  /* ============================================================ payment matching */

  const VERDICTS = {
    paid: ["Paid in full", "badge-ok", true],
    partial: ["Part-paid", "badge-warn", true],
    check: ["Amount not found", "badge-warn", false],
    "already-paid": ["Already paid", "", null],
    void: ["Void", "", null],
  };

  function runMatch() {
    const text = $("match-input").value,
      out = $("match-results");
    const invoices = Inv.all();
    S.match = null;
    $("match-apply").disabled = true;
    if (!text.trim()) {
      out.replaceChildren();
      return;
    }
    if (!invoices.length) {
      out.replaceChildren(
        el("p", {
          class: "fine",
          text: "You have no saved invoices to match against.",
        }),
      );
      return;
    }
    const res = Z.reconcile(
      text,
      /* A part-paid invoice is matched against its balance, skipping payments already recorded. */
      invoices.map((r) => ({
        id: r.id,
        zats: r.status === "partial" ? balanceOf(r) : BigInt(r.zats),
        status: r.status === "partial" ? "pending" : r.status,
        seen: r.status === "partial" ? paymentsOf(r).map((p) => p.txid).filter(Boolean) : [],
      })),
    );
    if (!res.matches.length) {
      out.replaceChildren(
        el(
          "div",
          { class: "notice notice-info" },
          icon("info"),
          el("div", {
            class: "notice-body",
            text: `Scanned ${plural(res.scanned, "line")}; none mention a saved invoice ID or a unique invoice amount. Make sure the export includes memos and amounts.`,
          }),
        ),
      );
      return;
    }
    S.match = res;
    const byId = new Map(invoices.map((r) => [r.id, r]));
    const rows = res.matches.map((m, i) => {
      const [label, cls, checked] = VERDICTS[m.verdict],
        coin = coinOf(byId.get(m.id).net);
      const box = el("input", {
        type: "checkbox",
        "data-i": i,
        "aria-label": `Apply to ${m.id}`,
        checked: !!checked,
        disabled: checked === null,
        onchange: syncApply,
      });
      return el(
        "tr",
        null,
        el("td", null, box),
        el("td", { class: "mono", text: m.id }),
        el("td", { class: "num", text: `${Z.formatAmount(m.due)} ${coin}` }),
        el("td", {
          class: "num",
          text: m.found != null ? `${Z.formatAmount(m.found)} ${coin}` : "–",
        }),
        el("td", {
          class: "mono",
          text: m.txids.length ? short(m.txids[0], 8, 6) : "–",
          title: m.txids.join("\n") || null,
        }),
        el(
          "td",
          null,
          el("span", { class: "badge " + cls, text: label }),
          m.via === "amount"
            ? el("span", {
                class: "tag",
                text: "by amount",
                title: "No invoice ID in the memo; matched by the invoice's unique amount",
              })
            : null,
        ),
      );
    });
    out.replaceChildren(
      el("p", {
        class: "fine",
        text: `Scanned ${plural(res.scanned, "line")}, matched ${plural(res.matches.length, "invoice")}. Ticked rows are recorded when you press Apply; "Amount not found" rows are recorded as paid in full if ticked.`,
      }),
      el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          { class: "table" },
          el(
            "thead",
            null,
            el(
              "tr",
              null,
              ["", "Invoice", "Due", "Found", "Transaction", "Result"].map(
                (h) => el("th", { text: h }),
              ),
            ),
          ),
          el("tbody", null, rows),
        ),
      ),
    );
    syncApply();
  }
  function syncApply() {
    const n = $$("#match-results input[type=checkbox]:checked").length;
    $("match-apply").disabled = !n;
    $("match-apply").lastChild.textContent = n
      ? `Apply to ${plural(n, "invoice")}`
      : "Apply";
  }
  function applyMatches() {
    if (!S.match) return;
    let n = 0;
    $$("#match-results input[type=checkbox]:checked").forEach((box) => {
      const m = S.match.matches[+box.dataset.i];
      if (
        applyPayment(m.id, {
          zats: m.found,
          txid: m.txids[0] || "",
          via: "matched",
        })
      )
        n++;
    });
    $("dlg-match").close();
    if (n) toast(`Recorded ${plural(n, "payment")}.`, "success");
  }

  /* ============================================================ batch */

  let setModeSeg = () => {};
  let bQR = null;
  const MODES = {
    "one-many": {
      label: "Recipients",
      unit: "recipient",
      format: "address, amount, memo",
      desc: "Everyone in the list is paid from one wallet in a single transaction. The QR code holds one multi-recipient ZIP-321 request, and each line can carry its own memo.",
      columns: Z.BATCH_COLUMNS["one-many"],
    },
    "many-one": {
      label: "Who owes what",
      unit: "payer",
      format: "name, amount",
      desc: "Each person gets their own request to your address. Their name and your reference go in the memo, so your wallet shows who has paid.",
      columns: Z.BATCH_COLUMNS["many-one"],
    },
    "many-many": {
      label: "Debts to settle",
      unit: "payment",
      format: "payer, recipient address, amount",
      desc: "One request per line: who pays, who receives, how much. Hand each payer their own code; the memo tells the recipient who paid.",
      columns: Z.BATCH_COLUMNS["many-many"],
    },
  };
  const UNIT_LABEL = {
    recipient: "Recipients",
    payer: "Payers",
    payment: "Payments",
  };

  function batchPlaceholder(mode) {
    const p = Z.NETS[S.net].uaPrefix;
    return mode === "one-many"
      ? `${p}…, 0.25, October payroll\n${p}…, 1.00`
      : mode === "many-one"
        ? "Ada, 0.42\nBen, 0.42"
        : `Ada, ${p}…, 0.40\nBen, ${p}…, 0.35`;
  }

  function updateBatch() {
    const mode = S.batchMode,
      m = MODES[mode],
      multi = mode !== "one-many",
      coin = coinOf(S.net);
    $("b-desc").textContent = m.desc;
    $("b-input-label").textContent = m.label;
    $("b-format").textContent = m.format;
    $("b-input").placeholder = batchPlaceholder(mode);
    $("b-merchant-field").hidden = mode !== "many-one";
    $("b-ref-field").hidden = !multi;
    $("b-count-label").textContent = UNIT_LABEL[m.unit];

    const { rows, issues } = Z.parseEntries(
      $("b-input").value,
      S.net,
      m.columns,
    );
    const ref = $("b-ref").value.trim();
    let merchant = null;
    if (mode === "many-one") {
      const raw = $("b-merchant").value.trim();
      merchant = raw ? Z.checkPayTo(raw, S.net) : null;
      renderAddressStatus(
        "b-merchant-status",
        "b-merchant",
        raw,
        merchant,
        !!raw || rows.length > 0,
      );
    }

    const built =
      mode === "many-one" && !(merchant && merchant.ok)
        ? { requests: [], issues: [] }
        : Z.buildBatch(mode, rows, {
            merchant: merchant && merchant.value,
            ref,
          });
    issues.push(...built.issues);
    const outs = built.requests.map((q) =>
      Object.assign(q, {
        title:
          mode === "one-many"
            ? plural(q.count, "recipient")
            : mode === "many-one"
              ? q.payer
              : `${q.payer} → ${short(q.to, 8, 6)}`,
      }),
    );
    S.batchOut = outs;
    if (S.batchSel >= outs.length) S.batchSel = 0;

    renderBatchIssues(issues.sort((a, b) => a.line - b.line));
    renderBatchTable(rows, m);

    const errors = issues.filter((i) => i.level === "error").length,
      total = rows.reduce((s, r) => s + r.amount, 0n);
    $("b-count").textContent = String(rows.length);
    $("b-total").textContent = Z.formatAmount(total);
    $("b-errors").textContent = String(errors);
    $("b-errors").classList.toggle("is-error", errors > 0);

    const sel = outs[S.batchSel];
    if (sel) {
      const res = bQR.show(
        sel.uri,
        `QR code: ${sel.title}, ${Z.formatAmount(sel.zats)} ${coin}`,
      );
      densityTag($("b-density"), res, sel.uri);
      $("b-uri").textContent = sel.uri;
      setBadge(
        "b-status",
        multi ? plural(outs.length, "request") : "Ready · 1 transaction",
        "badge-ok",
      );
    } else {
      const needMerchant =
        mode === "many-one" && rows.length && !(merchant && merchant.ok);
      bQR.clear(
        needMerchant
          ? "Add your receiving address"
          : errors
            ? "Fix the issues in the list"
            : "Add at least one valid line",
      );
      densityTag($("b-density"), null);
      $("b-uri").textContent = "zcash:…";
      setBadge(
        "b-status",
        errors || needMerchant ? "Needs attention" : "Waiting",
        errors || needMerchant ? "badge-danger" : "",
      );
    }
    $("b-qr-title").textContent = multi && sel ? sel.title : "Payment request";

    const list = $("b-list");
    list.hidden = !multi || !outs.length;
    list.replaceChildren(
      ...(multi
        ? outs.map((o, i) =>
            el(
              "li",
              null,
              el(
                "button",
                {
                  type: "button",
                  class: "uri-item",
                  "aria-current": String(i === S.batchSel),
                  onclick: () => {
                    S.batchSel = i;
                    updateBatch();
                  },
                },
                el(
                  "span",
                  { class: "uri-item-main" },
                  el("span", {
                    class: "uri-item-title",
                    text: `${o.title} · ${Z.formatAmount(o.zats)} ${coin}`,
                  }),
                  el("span", { class: "uri-item-sub", text: o.memo || o.uri }),
                ),
                icon("chevron"),
              ),
            ),
          )
        : []),
    );

    const any = !!sel;
    $("b-copy-uri").disabled =
      $("b-png").disabled =
      $("b-print").disabled =
      $("b-save").disabled =
        !any;
    $("b-copy").disabled = !any;
    $("b-copy").lastChild.textContent =
      multi && outs.length > 1 ? `Copy all ${outs.length}` : "Copy link";
    setLink($("b-open"), any ? sel.uri : "");
    $("b-note").textContent = !any
      ? ""
      : multi
        ? `Each person scans their own code: pick a name above to show it.${ref ? "" : " Add a reference to tag every memo."}`
        : `One transaction with ${plural(rows.length, "output")}. Wallet support for multi-recipient requests varies; check yours with the wallet kit on the Spec tests page.`;
  }

  function renderBatchIssues(issues) {
    const box = $("b-issues");
    box.hidden = !issues.length;
    if (!issues.length) return box.replaceChildren();
    const errors = issues.filter((i) => i.level === "error").length;
    box.classList.toggle("is-warning", !errors);
    box.replaceChildren(
      el("div", {
        class: "issues-title",
        text: errors
          ? `${plural(errors, "line")} need${errors === 1 ? "s" : ""} attention`
          : plural(issues.length, "warning"),
      }),
      el(
        "ul",
        null,
        issues.map((i) =>
          el(
            "li",
            { class: "issue" + (i.level === "warning" ? " is-warning" : "") },
            el("button", {
              type: "button",
              class: "line-ref",
              text: `Line ${i.line}`,
              onclick: () => selectLine(i.line),
            }),
            el("span", { text: i.message }),
          ),
        ),
      ),
    );
  }

  function renderBatchTable(rows, m) {
    const wrap = $("b-table-wrap");
    wrap.hidden = !rows.length;
    if (!rows.length) return;
    $("b-thead").replaceChildren(
      el(
        "tr",
        null,
        el("th", { text: "Line" }),
        m.columns.map((c) =>
          el("th", {
            text: c.label,
            class: c.type === "amount" ? "num" : null,
          }),
        ),
      ),
    );
    $("b-tbody").replaceChildren(
      ...rows.map((r) =>
        el(
          "tr",
          null,
          el("td", { class: "mono", text: r.line }),
          m.columns.map((c) => {
            const v = r[c.key];
            if (c.type === "address")
              return el("td", {
                class: "mono",
                text: short(v, 10, 6),
                title: v,
              });
            if (c.type === "amount")
              return el("td", { class: "num", text: Z.formatAmount(v) });
            return el("td", {
              class: c.type === "memo" ? "wrap" : null,
              text: v || "–",
            });
          }),
        ),
      ),
    );
  }

  function selectLine(n) {
    const ta = $("b-input"),
      lines = ta.value.split("\n");
    let start = 0;
    for (let i = 0; i < n - 1 && i < lines.length; i++)
      start += lines[i].length + 1;
    ta.focus();
    ta.setSelectionRange(start, start + (lines[n - 1] || "").length);
  }

  function importBatchFile(file) {
    if (!file) return;
    if (file.size > 2e6) return toast("That file is over 2 MB.", "error");
    file
      .text()
      .then((t) => {
        $("b-input").value = t.replace(/\r\n?/g, "\n").trim();
        updateBatch();
        toast(`Imported ${file.name}.`, "success");
      })
      .catch(() => toast("Could not read that file.", "error"));
  }

  function fillBatchDemo() {
    const A = (i) => Z.demoAddress(S.net, i);
    if (S.batchMode === "one-many")
      $("b-input").value =
        `address, amount, memo\n${A(11)}, 0.25, October payroll\n${A(12)}, 1.00, Design invoice #7\n${A(13)}, 0.05`;
    else if (S.batchMode === "many-one") {
      $("b-merchant").value = A(10);
      $("b-ref").value = "DINNER-OCT26";
      $("b-input").value = "Ada, 0.42\nBen, 0.42\nChen, 0.38";
    } else {
      $("b-ref").value = "TRIP-2026";
      $("b-input").value =
        `Ada, ${A(12)}, 0.40\nBen, ${A(13)}, 0.35\nChen, ${A(12)}, 0.10`;
    }
    S.batchSel = 0;
    updateBatch();
    toast("Demo data filled. Demo addresses cannot receive funds.");
  }

  function printBatch() {
    const outs = S.batchOut,
      coin = coinOf(S.net),
      multi = S.batchMode !== "one-many";
    if (!outs.length) return;
    const head = el(
      "div",
      { class: "doc-head" },
      el(
        "div",
        null,
        el("div", {
          class: "doc-business",
          text: settings.business || "Zectill",
        }),
        el("div", {
          class: "doc-sub",
          text: $("b-ref").value.trim() || nowIso().slice(0, 10),
        }),
      ),
      el("div", {
        class: "doc-title",
        text: multi ? "Payment requests" : "Payout",
      }),
    );
    let body;
    if (multi) {
      body = el(
        "div",
        { class: "sheet" },
        outs.map((o) =>
          el(
            "div",
            { class: "sheet-card" },
            el("div", { class: "sheet-name", text: o.payer }),
            qrImg(o.uri, `Payment QR for ${o.payer}`),
            el("div", {
              class: "sheet-amt",
              text: `${Z.formatAmount(o.zats)} ${coin}`,
            }),
            el("div", { class: "sheet-memo", text: o.memo || "" }),
          ),
        ),
      );
    } else {
      const { rows } = Z.parseEntries(
        $("b-input").value,
        S.net,
        MODES["one-many"].columns,
      );
      body = el(
        "div",
        null,
        el(
          "div",
          { class: "doc-body" },
          el(
            "table",
            { class: "doc-table" },
            el(
              "tbody",
              null,
              rows.map((r) =>
                el(
                  "tr",
                  null,
                  el("th", { text: short(r.address, 14, 8) }),
                  el("td", {
                    text: `${Z.formatAmount(r.amount)} ${coin}${r.memo ? " · " + r.memo : ""}`,
                  }),
                ),
              ),
            ),
          ),
          el(
            "div",
            { class: "doc-qr" },
            qrImg(outs[0].uri, "Batch payment QR code"),
            el("div", {
              text: `Total ${Z.formatAmount(outs[0].zats)} ${coin}`,
            }),
          ),
        ),
        el("div", { class: "doc-uri", text: outs[0].uri }),
      );
    }
    printNode(
      el(
        "div",
        { class: "doc" },
        head,
        body,
        el("div", {
          class: "doc-foot",
          text: "Generated locally with Zectill (ZIP-321).",
        }),
      ),
    );
  }

  const Batches = {
    all() {
      const a = store.get(KEYS.batches, []);
      return Array.isArray(a) ? a : [];
    },
    save(list) {
      store.set(KEYS.batches, list);
      renderSavedBatches();
    },
  };

  function saveBatch() {
    const outs = S.batchOut;
    if (!outs.length) return;
    const total = outs.reduce((s, o) => s + o.zats, 0n),
      m = MODES[S.batchMode];
    const rec = {
      id:
        "B-" +
        Array.from(
          crypto.getRandomValues(new Uint8Array(5)),
          (b) => ID_CHARS[b & 31],
        ).join(""),
      mode: S.batchMode,
      net: S.net,
      createdAt: nowIso(),
      input: $("b-input").value,
      merchant: $("b-merchant").value.trim(),
      ref: $("b-ref").value.trim(),
      count:
        S.batchMode === "one-many"
          ? Z.parseEntries($("b-input").value, S.net, m.columns).rows.length
          : outs.length,
      zats: String(total),
    };
    Batches.save([rec].concat(Batches.all()).slice(0, 50));
    toast("Batch saved.", "success");
  }

  function renderSavedBatches() {
    const list = Batches.all();
    $("b-saved-empty").hidden = !!list.length;
    $("b-saved").replaceChildren(
      ...list.map((b) =>
        el(
          "li",
          null,
          el(
            "div",
            { class: "saved-main" },
            el("div", {
              class: "saved-title",
              text: `${b.ref || { "one-many": "Payout", "many-one": "Bill split", "many-many": "Settlement" }[b.mode]} · ${plural(b.count, MODES[b.mode].unit)}`,
            }),
            el("div", {
              class: "saved-sub",
              text: `${fmtZ(b.zats)} ${coinOf(b.net)} · ${relTime(b.createdAt)}${b.net === "test" ? " · Testnet" : ""}`,
            }),
          ),
          el(
            "div",
            { class: "row-wrap" },
            el(
              "button",
              {
                type: "button",
                class: "btn btn-secondary btn-sm",
                onclick: () => loadBatch(b),
              },
              "Load",
            ),
            el(
              "button",
              {
                type: "button",
                class: "btn btn-ghost btn-icon btn-sm",
                "aria-label": "Delete saved batch",
                title: "Delete",
                onclick: () => {
                  Batches.save(Batches.all().filter((x) => x.id !== b.id));
                  toast("Saved batch deleted.", "info", {
                    label: "Undo",
                    run: () => Batches.save([b].concat(Batches.all())),
                  });
                },
              },
              icon("trash"),
            ),
          ),
        ),
      ),
    );
  }

  function loadBatch(b) {
    if (b.net !== S.net) setNetwork(b.net, { silent: true });
    S.batchMode = b.mode;
    setModeSeg(b.mode);
    S.batchSel = 0;
    $("b-input").value = b.input || "";
    $("b-merchant").value = b.merchant || "";
    $("b-ref").value = b.ref || "";
    updateBatch();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ============================================================ inspector */

  const SPEC_EXAMPLE =
    "zcash:?address=tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU&amount=123.456&address.1=ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez&amount.1=0.789&memo.1=VGhpcyBpcyBhIHVuaWNvZGUgbWVtbyDinKjwn6aE8J-PhvCfjok";
  const netName = (n) =>
    Z.NETS[n] ? Z.NETS[n].name : n === "regtest" ? "Regtest" : n;

  function verdictBox(ok, title, sub) {
    return el(
      "div",
      { class: "verdict " + (ok ? "is-ok" : "is-error") },
      icon(ok ? "shield" : "alert"),
      el(
        "div",
        null,
        el("div", { class: "verdict-title", text: title }),
        sub ? el("div", { class: "verdict-sub", text: sub }) : null,
      ),
    );
  }

  function addressRows(a) {
    const rows = [
      ["Address", el("span", { class: "break", text: a.address })],
      ["Type", Z.KIND_LABELS[a.kind]],
      ["Network", netName(a.net)],
    ];
    if (a.kind === "unified") {
      rows.push([
        "Revision",
        a.revision === 2
          ? `2 (${a.transparentIncluding ? "may include transparent" : "shielded-only"})`
          : "0",
      ]);
      rows.push([
        "Receivers",
        el(
          "span",
          { class: "tags" },
          a.items
            .filter((i) => i.typecode < 0xc0 || i.typecode > 0xfc)
            .map((i) => {
              const k = Z.ua.RECEIVERS[i.typecode];
              return el("span", {
                class: "tag" + (k && k.shielded ? " tag-accent" : ""),
                text: `${k ? k.label : "Unknown 0x" + i.typecode.toString(16)} · ${i.data.length} B`,
              });
            }),
        ),
      ]);
      if (a.expiryHeight)
        rows.push(["Expires at block", String(a.expiryHeight)]);
      if (a.expiryTime)
        rows.push(["Expires", fmtDate(new Date(a.expiryTime).toISOString())]);
      if (Z.isDemoAddress(a))
        rows.push([
          "Note",
          "Zectill demo address: wallets will refuse to pay it.",
        ]);
    }
    rows.push([
      "Memos",
      a.canMemo ? "Can receive encrypted memos" : "Cannot receive memos",
    ]);
    const policy =
      a.net === "main" || a.net === "test"
        ? Z.checkPayTo(a.address, a.net)
        : { ok: false, error: "Regtest addresses are not supported." };
    rows.push([
      "Zectill policy",
      policy.ok ? "Accepted as a receiving address" : policy.error,
    ]);
    return { rows, policy };
  }

  function kvList(rows) {
    return el(
      "dl",
      { class: "kv" },
      rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", null, v)]),
    );
  }

  function updateInspect() {
    const raw = $("x-input").value.trim(),
      out = $("x-result");
    out.replaceChildren();
    if (!raw) return;
    if (/^zcash:/i.test(raw)) {
      const r = Z.zip321.parse(raw);
      if (!r.ok)
        return out.append(
          verdictBox(
            false,
            "Not a valid payment request",
            `${r.error} A spec-compliant wallet should refuse it.`,
          ),
        );
      const n = r.payments.length,
        coin = n ? coinOf(r.payments[0].info.net) : "ZEC";
      out.append(
        verdictBox(
          true,
          n
            ? `Valid ZIP-321 request · ${plural(n, "payment")}`
            : "Valid, but it requests no payments",
          n
            ? r.total != null
              ? `Total ${Z.formatAmount(r.total)} ${coin}${n > 1 ? " in one transaction" : ""}`
              : "At least one payment leaves the amount to the payer."
            : "",
        ),
      );
      r.payments.forEach((p, i) => {
        const { rows } = addressRows(p.info);
        rows.splice(1, 0, [
          "Amount",
          p.zats != null
            ? `${Z.formatAmount(p.zats)} ${coinOf(p.info.net)}`
            : "Not specified (payer chooses)",
        ]);
        if (p.memo)
          rows.push(
            [
              "Memo",
              p.memo.text != null
                ? p.memo.text
                : el("span", {
                    class: "break",
                    text: Z.bytes.toHex(p.memo.bytes),
                  }),
            ],
            ["Memo size", `${p.memo.bytes.length} of ${Z.MEMO_MAX} bytes`],
          );
        if (p.label != null) rows.push(["Label", p.label || "(empty)"]);
        if (p.message != null) rows.push(["Message", p.message || "(empty)"]);
        p.other.forEach(([k, v]) => rows.push([`Parameter “${k}”`, v]));
        const card = el(
          "div",
          { class: "pay-card" },
          el(
            "h3",
            null,
            n > 1 ? `Payment ${i + 1}` : "Payment",
            el("span", {
              class: "tag",
              text: p.index ? `index .${p.index}` : "index (empty)",
            }),
          ),
          kvList(rows),
        );
        if (
          n === 1 &&
          p.info.kind === "unified" &&
          (p.info.net === "main" || p.info.net === "test") &&
          Z.checkPayTo(p.address, p.info.net).ok
        ) {
          card.append(
            el(
              "div",
              { class: "row-wrap" },
              el(
                "button",
                {
                  type: "button",
                  class: "btn btn-secondary btn-sm",
                  onclick: () => loadIntoInvoice(p),
                },
                icon("plus"),
                "Use in a new invoice",
              ),
            ),
          );
        }
        out.append(card);
      });
      return;
    }
    const a = Z.classifyAddress(raw);
    if (!a.ok)
      return out.append(
        verdictBox(
          false,
          a.kind ? `Invalid ${Z.KIND_LABELS[a.kind]}` : "Not a Zcash address",
          a.error,
        ),
      );
    const { rows, policy } = addressRows(a);
    const card = el("div", { class: "pay-card" }, kvList(rows));
    if (policy.ok)
      card.append(
        el(
          "div",
          { class: "row-wrap" },
          el(
            "button",
            {
              type: "button",
              class: "btn btn-secondary btn-sm",
              onclick: () => {
                if (a.net !== S.net) setNetwork(a.net, { silent: true });
                startDraft();
                $("inv-address").value = a.address;
                showTab("invoice");
                updateDraft();
                $("inv-amount").focus();
              },
            },
            icon("qr"),
            "Invoice to this address",
          ),
        ),
      );
    out.append(
      verdictBox(true, `Valid ${Z.KIND_LABELS[a.kind]}`, netName(a.net)),
      card,
    );
  }

  function loadIntoInvoice(p) {
    if (p.info.net !== S.net) setNetwork(p.info.net, { silent: true });
    if (S.unit === "fiat") {
      S.unit = "coin";
      syncUnitUI();
    }
    startDraft();
    $("inv-address").value = p.address;
    $("inv-amount").value = p.zats != null ? Z.formatAmount(p.zats) : "";
    $("inv-label").value = p.label || "";
    $("inv-message").value = p.message || "";
    $("inv-note").value = p.memo && p.memo.text ? p.memo.text : "";
    $("inv-more").open = !!(p.label || p.message || (p.memo && p.memo.text));
    showTab("invoice");
    updateDraft();
    toast("Loaded into a new invoice. Check the details before saving.");
  }

  /* ============================================================ settings & backup */

  function openSettings() {
    $("set-business").value = settings.business;
    $("set-currency").value = settings.currency;
    $("set-lock").value = String(settings.lockMin);
    $("set-unique").checked = !!settings.uniqueAmounts;
    renderPinSetting();
    setThemeSeg(themePref);
    $("dlg-settings").showModal();
  }

  function exportBackup() {
    const data = {
      app: "zectill",
      version: 2,
      exportedAt: nowIso(),
      invoices: Inv.all(),
      batches: Batches.all(),
      settings,
    };
    downloadBlob(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      `zectill-backup-${nowIso().slice(0, 10)}.json`,
    );
    toast("Backup downloaded.", "success");
  }

  async function importBackup(file) {
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      return toast("That file is not valid JSON.", "error");
    }
    if (!data || data.app !== "zectill" || !Array.isArray(data.invoices))
      return toast("That is not a Zectill backup file.", "error");
    const incoming = data.invoices.filter(
      (r) =>
        r &&
        typeof r.id === "string" &&
        /^\d+$/.test(String(r.zats)) &&
        Z.zip321.parse(r.uri).ok,
    );
    const ok = await confirmDialog({
      title: "Import backup?",
      body: `${plural(incoming.length, "invoice")} and ${plural((data.batches || []).length, "saved batch")} will be merged. Where an invoice exists in both, the more recently updated copy is kept.`,
      ok: "Import",
    });
    if (!ok) return;
    const map = new Map(Inv.all().map((r) => [r.id, r]));
    for (const r of incoming) {
      const cur = map.get(r.id);
      if (!cur || String(r.updatedAt) > String(cur.updatedAt)) map.set(r.id, r);
    }
    Inv.save([...map.values()]);
    const bmap = new Map(Batches.all().map((b) => [b.id, b]));
    for (const b of Array.isArray(data.batches) ? data.batches : [])
      if (b && b.id && MODES[b.mode]) bmap.set(b.id, b);
    Batches.save(
      [...bmap.values()].sort((a, b) =>
        String(b.createdAt).localeCompare(String(a.createdAt)),
      ),
    );
    if (data.settings && typeof data.settings === "object") {
      if (typeof data.settings.business === "string")
        settings.business = data.settings.business.slice(0, 60);
      if (CURRENCIES.includes(data.settings.currency))
        settings.currency = data.settings.currency;
      if ([5, 10, 15, 30, 60].includes(+data.settings.lockMin))
        settings.lockMin = +data.settings.lockMin;
      saveSettings();
    }
    $("dlg-settings").close();
    renderHistory();
    syncUnitUI();
    renderChips();
    toast(`Imported ${plural(incoming.length, "invoice")}.`, "success");
  }

  async function wipeAll() {
    const ok = await confirmDialog({
      title: "Erase all Zectill data?",
      body: "This deletes every invoice, saved batch, saved address and setting from this browser. Export a backup first if you might need them.",
      ok: "Erase everything",
      danger: true,
    });
    if (!ok) return;
    [
      KEYS.invoices,
      KEYS.batches,
      KEYS.settings,
      KEYS.net,
      KEYS.legacy,
      KEYS.addr("main"),
      KEYS.addr("test"),
      KEYS.pin,
      KEYS.pinFails,
      KEYS.posLock,
      "zectill.v2.walletkit",
    ].forEach(store.remove);
    location.reload();
  }

  /* ============================================================ tabs */

  const TABS = ["invoice", "invoices", "batch", "inspect"];
  let setTabSeg = () => {};

  function showTab(tab, fromUser) {
    if (!TABS.includes(tab)) tab = "invoice";
    S.tab = tab;
    setTabSeg(tab);
    TABS.forEach((t) => {
      $("panel-" + t).hidden = t !== tab;
    });
    if (location.hash.slice(1) !== tab)
      history.replaceState(null, "", "#" + tab);
    if (tab === "invoices") renderHistory();
    else if (tab === "batch") {
      updateBatch();
      renderSavedBatches();
    } else if (tab === "inspect") updateInspect();
    if (fromUser) window.scrollTo({ top: 0 });
  }

  /* ============================================================ wiring */

  function onAmountInput() {
    if (S.unit === "fiat") {
      S.quote = null;
      renderQuote();
      requestQuoteSoon();
    }
    updateDraftSoon();
  }
  const updateDraftSoon = debounce(updateDraft, 120);

  function wire() {
    /* editor */
    $("inv-address").addEventListener("input", updateDraftSoon);
    $("inv-address").addEventListener("blur", () => {
      if ($("inv-address").value.trim()) S.touched.add("address");
      updateDraft();
    });
    $("inv-amount").addEventListener("input", onAmountInput);
    ["inv-id", "inv-label", "inv-message", "inv-note"].forEach((id) =>
      $(id).addEventListener("input", updateDraftSoon),
    );
    $("inv-id-new").addEventListener("click", () => {
      $("inv-id").value = newInvoiceId();
      updateDraft();
    });
    $("inv-demo").addEventListener("click", () => {
      if (S.current) return;
      $("inv-address").value = Z.demoAddress(S.net, 1);
      if (!$("inv-amount").value.trim() && S.unit === "coin")
        $("inv-amount").value = "0.1";
      S.touched.add("address");
      updateDraft();
      toast(
        "Demo address filled. It passes every check but no one owns it, so wallets will refuse it.",
      );
    });
    $("inv-remember").addEventListener("change", (e) => {
      settings.remember = e.target.checked;
      saveSettings();
      if (!e.target.checked) store.remove(KEYS.addr(S.net));
      else {
        const a = Z.checkPayTo($("inv-address").value, S.net);
        if (a.ok) store.set(KEYS.addr(S.net), a.value);
      }
    });
    $("inv-currency").addEventListener("change", (e) => {
      settings.currency = e.target.value;
      saveSettings();
      syncUnitUI();
      renderChips();
      requestQuote();
    });
    $("quote-refresh").addEventListener("click", () => requestQuote(true));
    $("inv-form").addEventListener("submit", (e) => {
      e.preventDefault();
      issueDraft();
    });
    $("inv-clear").addEventListener("click", () => {
      startDraft();
      $("inv-amount").focus();
    });
    $("inv-new").addEventListener("click", () => {
      startDraft();
      $("inv-amount").focus();
    });
    $("inv-dup").addEventListener("click", () => {
      if (S.current) duplicateInvoice(S.current);
    });

    /* preview actions (sharing a draft saves it first) */
    $("pv-pos").addEventListener("click", () => withInvoice(openPOS));
    $("pv-copy-uri").addEventListener("click", () =>
      withInvoice((r) => copyText(requestOf(r).uri, "Payment link copied.")),
    );
    $("pv-open").addEventListener("click", (e) => {
      if (!withInvoice()) e.preventDefault();
    });
    $("pv-png").addEventListener("click", () =>
      withInvoice((r) => {
        const req = requestOf(r);
        paymentPng(
          req.uri,
          {
            title: settings.business,
            amount: `${Z.formatAmount(req.zats)} ${coinOf(r.net)}${req.balance ? " balance" : ""}`,
            sub: [r.label, r.id].filter(Boolean).join(" · "),
          },
          `${r.id}${req.balance ? "-balance" : ""}.png`,
        );
      }),
    );
    $("pv-print").addEventListener("click", () => withInvoice(printInvoice));
    $("pv-paid").addEventListener("click", () =>
      withInvoice((r) => openPaidDialog(r.id)),
    );
    $("pv-requote").addEventListener("click", () =>
      S.current ? refreshInvoiceQuote(S.current.id) : requestQuote(true),
    );

    /* record-payment dialog */
    $("paid-form").addEventListener("submit", (e) => {
      if (!e.submitter || e.submitter.value !== "ok") return;
      const amt = Z.parseAmount(
          $("paid-amount")
            .value.trim()
            .replace(/^(\d+),(\d+)$/, "$1.$2"),
        ),
        tx = $("paid-txid").value.trim().toLowerCase();
      let bad = false;
      if (!amt.ok || amt.zats === 0n) {
        setInvalid("paid-amount", true);
        setStatus(
          "paid-amount-status",
          "error",
          amt.ok ? "Enter the amount you received." : amt.error,
        );
        bad = true;
      }
      if (tx && !/^[0-9a-f]{64}$/.test(tx)) {
        setInvalid("paid-txid", true);
        setStatus(
          "paid-txid-status",
          "error",
          "A transaction ID is 64 hexadecimal characters.",
        );
        bad = true;
      }
      if (bad) {
        e.preventDefault();
        return;
      }
      markPaid($("dlg-paid").dataset.id, {
        zats: amt.zats,
        txid: tx,
        via: "manual",
      });
    });

    /* customer screen */
    $("pos-close").addEventListener("click", () => leavePOS());
    $("pos-done").addEventListener("click", () => leavePOS());
    $("pos-next").addEventListener("click", () =>
      leavePOS(() => {
        startDraft();
        showTab("invoice");
        $("inv-amount").focus();
      }),
    );
    $("pos-copy").addEventListener("click", () => {
      const r = Inv.get(S.posId);
      if (r) copyText(requestOf(r).uri, "Payment link copied.");
    });
    /* A short (or different) payment at the counter: record the amount without leaving the
       customer screen. Part-paid re-renders it with the balance QR; paid in full shows success. */
    $("pos-other").addEventListener("click", async () => {
      const id = S.posId;
      if (!id) return;
      if (await posGuard("Merchant PIN", "Enter the PIN to record a payment.")) openPaidDialog(id);
    });
    /* Press and hold to confirm, so a tap from the customer's side of the screen does nothing. */
    const holdBtn = $("pos-paid"),
      HOLD_MS = 1200;
    let holdTimer = null;
    const startHold = (e) => {
      if (!S.posId || holdTimer || pinOn()) return;
      if (e.type === "keydown") {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
      }
      holdBtn.classList.add("is-holding");
      holdTimer = setTimeout(() => {
        holdTimer = null;
        holdBtn.classList.remove("is-holding");
        markPaid(S.posId, { via: "pos" });
      }, HOLD_MS);
    };
    const cancelHold = () => {
      if (!holdTimer) return;
      clearTimeout(holdTimer);
      holdTimer = null;
      holdBtn.classList.remove("is-holding");
    };
    holdBtn.addEventListener("pointerdown", startHold);
    holdBtn.addEventListener("keydown", startHold);
    ["pointerup", "pointerleave", "pointercancel", "keyup", "blur"].forEach(
      (t) => holdBtn.addEventListener(t, cancelHold),
    );
    /* A plain click only counts when a PIN guards the confirmation. */
    holdBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!S.posId || !pinOn()) return;
      const id = S.posId;
      if (await posGuard("Merchant PIN", "Enter the PIN to confirm this payment.")) markPaid(id, { via: "pos" });
    });
    holdBtn.addEventListener("contextmenu", (e) => e.preventDefault());
    $("pos-requote").addEventListener("click", () => {
      if (S.posId) refreshInvoiceQuote(S.posId);
    });
    $("pos").addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        leavePOS();
        return;
      }
      if (e.key !== "Tab") return;
      const f = $$("button:not([disabled])", $("pos")).filter(
        (b) => b.offsetParent !== null,
      );
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
        e.preventDefault();
        f[0].focus();
      }
    });

    /* history */
    $("h-new").addEventListener("click", () => {
      startDraft();
      showTab("invoice");
      $("inv-amount").focus();
    });
    $("h-csv").addEventListener("click", exportCsv);
    $("h-match").addEventListener("click", () => {
      $("dlg-match").showModal();
      runMatch();
      $("match-input").focus();
    });
    $("h-search").addEventListener(
      "input",
      debounce((e) => {
        S.search = e.target.value;
        renderHistory();
      }, 100),
    );
    $("match-input").addEventListener("input", debounce(runMatch, 200));
    $("match-file-btn").addEventListener("click", () =>
      $("match-file").click(),
    );
    $("match-file").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      if (f.size > 5e6) return toast("That file is over 5 MB.", "error");
      $("match-input").value = await f.text();
      runMatch();
    });
    $("match-apply").addEventListener("click", applyMatches);
    document.addEventListener("click", (e) => {
      $$("details.menu[open]").forEach((d) => {
        if (!d.contains(e.target)) d.open = false;
      });
    });
    document.addEventListener(
      "toggle",
      (e) => {
        if (
          e.target.matches &&
          e.target.matches("details.menu") &&
          e.target.open
        ) {
          $$("details.menu[open]").forEach((d) => {
            if (d !== e.target) d.open = false;
          });
          const first = e.target.querySelector(".menu-pop button");
          if (first) first.focus();
        }
      },
      true,
    );
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const open = document.querySelector("details.menu[open]");
      if (open) {
        open.open = false;
        open.querySelector("summary").focus();
      }
    });

    /* batch */
    const updateBatchSoon = debounce(updateBatch, 150);
    ["b-input", "b-merchant", "b-ref"].forEach((id) =>
      $(id).addEventListener("input", updateBatchSoon),
    );
    $("b-import").addEventListener("click", () => $("b-file").click());
    $("b-file").addEventListener("change", (e) => {
      importBatchFile(e.target.files[0]);
      e.target.value = "";
    });
    const drop = $("b-drop");
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("is-over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("is-over");
      importBatchFile(e.dataTransfer.files[0]);
    });
    $("b-demo").addEventListener("click", fillBatchDemo);
    $("b-clear").addEventListener("click", () => {
      $("b-input").value = "";
      S.batchSel = 0;
      updateBatch();
      $("b-input").focus();
    });
    $("b-copy-uri").addEventListener("click", () => {
      const o = S.batchOut[S.batchSel];
      if (o) copyText(o.uri, "Payment link copied.");
    });
    $("b-copy").addEventListener("click", () => {
      const outs = S.batchOut,
        coin = coinOf(S.net);
      if (!outs.length) return;
      if (outs.length === 1)
        return copyText(outs[0].uri, "Payment link copied.");
      copyText(
        outs
          .map(
            (o) => `${o.payer} (${Z.formatAmount(o.zats)} ${coin}): ${o.uri}`,
          )
          .join("\n"),
        `${outs.length} payment links copied, one per line.`,
      );
    });
    $("b-png").addEventListener("click", () => {
      const o = S.batchOut[S.batchSel];
      if (!o) return;
      const multi = S.batchMode !== "one-many";
      paymentPng(
        o.uri,
        {
          title: settings.business || (multi ? "" : "Batch payout"),
          amount: `${Z.formatAmount(o.zats)} ${coinOf(S.net)}`,
          sub: multi ? o.memo : o.title,
        },
        `zectill-${multi ? o.payer.replace(/[^\w-]+/g, "_") : "payout"}.png`,
      );
    });
    $("b-print").addEventListener("click", printBatch);
    $("b-save").addEventListener("click", saveBatch);

    /* inspector */
    $("x-input").addEventListener("input", debounce(updateInspect, 150));
    $("x-example").addEventListener("click", () => {
      $("x-input").value = SPEC_EXAMPLE;
      updateInspect();
    });
    $("x-clear").addEventListener("click", () => {
      $("x-input").value = "";
      updateInspect();
      $("x-input").focus();
    });

    /* settings */
    $("settings-btn").addEventListener("click", openSettings);
    $$("[data-open-settings]").forEach((b) =>
      b.addEventListener("click", openSettings),
    );
    $("theme-btn").addEventListener("click", () =>
      applyTheme(THEME_NEXT[themePref], true),
    );
    $("set-business").addEventListener("input", (e) => {
      settings.business = e.target.value.trim().slice(0, 60);
      saveSettings();
      if (S.posId) renderPOS();
    });
    $("set-currency").addEventListener("change", (e) => {
      settings.currency = e.target.value;
      saveSettings();
      syncUnitUI();
      renderChips();
      requestQuote();
    });
    $("set-lock").addEventListener("change", (e) => {
      settings.lockMin = +e.target.value;
      saveSettings();
    });
    $("set-export").addEventListener("click", exportBackup);
    $("set-import").addEventListener("click", () =>
      $("set-import-file").click(),
    );
    $("set-import-file").addEventListener("change", (e) => {
      importBackup(e.target.files[0]);
      e.target.value = "";
    });
    $("set-forget").addEventListener("click", () => {
      store.remove(KEYS.addr("main"));
      store.remove(KEYS.addr("test"));
      toast("Saved addresses forgotten.");
    });
    $("set-wipe").addEventListener("click", wipeAll);
    $("set-pin").addEventListener("click", setupPin);
    $("set-pin-off").addEventListener("click", removePin);
    $("pin-forgot").addEventListener("click", () => {
      $("pin-msg").textContent =
        "The PIN is stored only on this device. To reset it, clear this site's data in your browser settings. That also erases invoices you haven't backed up.";
    });
    $("set-unique").addEventListener("change", (e) => {
      settings.uniqueAmounts = e.target.checked;
      saveSettings();
      if (!S.current) updateDraft();
    });

    window.addEventListener("hashchange", () =>
      showTab(location.hash.slice(1)),
    );
    window.addEventListener("afterprint", () =>
      $("print-root").replaceChildren(),
    );
    darkMq.addEventListener("change", () => {
      if (themePref === "system") applyTheme("system");
    });
    document.addEventListener("visibilitychange", () => {
      if (
        document.visibilityState === "visible" &&
        S.posId &&
        navigator.wakeLock &&
        !S.wakeLock
      )
        navigator.wakeLock
          .request("screen")
          .then((l) => {
            S.wakeLock = l;
          })
          .catch(() => {});
    });
  }

  /* ============================================================ start */

  function init() {
    migrateLegacy();
    const opts = CURRENCIES.map((c) => el("option", { value: c, text: c }));
    $("inv-currency").replaceChildren(...opts.map((o) => o.cloneNode(true)));
    $("set-currency").replaceChildren(...opts);
    $("inv-remember").checked = !!settings.remember;

    pvQR = QRView("pv-qr", "pv-empty", "pv-empty-msg", "pv-stage");
    bQR = QRView("b-qr", "b-empty", "b-empty-msg", "b-stage");
    setNetSeg = segmented($("net"), (n) => setNetwork(n));
    setUnitSeg = segmented($("inv-unit"), (u) => setUnit(u));
    setFilterSeg = segmented($("h-filter"), (f) => {
      S.filter = f;
      renderHistory();
    });
    setModeSeg = segmented($("b-mode"), (m) => {
      S.batchMode = m;
      S.batchSel = 0;
      updateBatch();
    });
    setThemeSeg = segmented($("set-theme"), (t) => applyTheme(t, true));
    setTabSeg = segmented($("tabs"), (t) => showTab(t, true));
    setFilterSeg("all");
    setModeSeg("one-many");
    applyTheme(themePref);
    wire();

    $("inv-address").value = store.get(KEYS.addr(S.net), "") || "";
    $("inv-id").value = newInvoiceId();
    setNetwork(S.net, { silent: true });
    showTab(location.hash.slice(1) || "invoice");
    renderSavedBatches();
    const locked = store.get(KEYS.posLock, null);
    if (locked && pinOn() && Inv.get(locked)) openPOS(Inv.get(locked));
    else store.remove(KEYS.posLock);
    setInterval(tick, 1000);
  }

  init();
})();
