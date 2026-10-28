# Vendored dependencies

| File | Package | License | Integrity |
|---|---|---|---|
| `qrcode-generator-2.0.4.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 by Kazuhiko Arase, `dist/qrcode.js` from npm | MIT (see the file header) | `sha384-e9EFD6BGC90bkW9aDV5xbbBfzwN7G8YImHao2lfLVKV/hPB0E0go+H3I64h7oHtA` |

The file is self-hosted, so the page loads no third-party scripts and the Content-Security-Policy can be `script-src 'self'`. To verify it, compute the SHA-384 of the file and compare it with the value above, which matches the jsDelivr copy:

```sh
openssl dgst -sha384 -binary vendor/qrcode-generator-2.0.4.js | openssl base64 -A
```
