# Wire-Compatibility Fixtures

This directory contains binary fixtures that represent the exact bytes sent over
the WebSocket wire between the Ojin proxy and a client SDK.  They are the
ground-truth reference for the binary protocol documented in
`src/protocol/interaction-messages.ts` and guarantee that the TypeScript and
Python `ojin-client` implementations stay byte-compatible across refactors.

---

## Fixture inventory

<!-- markdownlint-disable MD013 -->
| File                              | Direction         | Encoding   | Message shape                               |
|-----------------------------------|-------------------|------------|---------------------------------------------|
| `text_input.bin`                  | client → server   | binary     | `InteractionInput` / text / no params       |
| `text_input_unicode.bin`          | client → server   | binary     | `InteractionInput` / text / unicode + params|
| `audio_input.bin`                 | client → server   | binary     | `InteractionInput` / audio / no params      |
| `cancel_interaction.bin`          | client → server   | JSON UTF-8 | `CancelInteraction`                         |
| `end_interaction.bin`             | client → server   | JSON UTF-8 | `EndInteraction`                            |
| `session_ready.bin`               | server → client   | JSON UTF-8 | `SessionReady`                              |
| `interaction_response_jpeg.bin`   | server → client   | binary     | `InteractionResponse` / image payload       |
| `interaction_response_audio.bin`  | server → client   | binary     | `InteractionResponse` / audio / nil UUID    |
| `error_response.bin`              | server → client   | JSON UTF-8 | `ErrorResponse`                             |
<!-- markdownlint-enable MD013 -->

Each `.bin` file has a sidecar `.json` metadata file with:

- `fixtureName` — canonical name used in test output
- `pythonSdkVersion` — Python `ojin-client` version used to capture the fixture
- `messageShape` — human-readable description
- `direction` — `client-to-server` | `server-to-client`
- `encoding` — `binary` | `json-utf8`
- `fields` — the logical values encoded in the fixture
- `expectedRoundTrip` — assertions the test suite verifies on deserialization

---

## Running the suite

```bash
# Separate wire-compat run (fast — no full test suite required):
pnpm test:wire-compat

# Or as part of the full test run:
pnpm test
```

A failure message names the diverging fixture and prints the first 64 bytes of
the diff so you can pinpoint the exact field that shifted.

---

## Regenerating fixtures from the Python SDK

If the wire protocol intentionally changes (e.g. a new field is added to
`InteractionInput` header), regenerate the fixtures by running the Python SDK
against a scripted fixture-capture proxy shim.

### Prerequisites

```bash
pip install ojin-client==<target-version> websockets
```

### Capture shim — `tools/capture_wire_fixtures.py`

```python
"""
Wire-fixture capture shim for ojin-client Python SDK.

Usage:
    python tools/capture_wire_fixtures.py

Starts a local WebSocket proxy that intercepts all frames sent by the Python
SDK, writes each one to tests/fixtures/wire/<fixture_name>.bin, then tears
down cleanly.
"""

import asyncio, json, pathlib, websockets
from ojin_client import OjinClient  # adjust import to actual package layout

OUT = pathlib.Path("tests/fixtures/wire")
OUT.mkdir(parents=True, exist_ok=True)

FIXED_TS = 1_000_000_000   # milliseconds — keep in sync with fixture metadata

class CapturingProxy:
    """Thin in-process WebSocket proxy that tees client frames to disk."""

    async def run(self):
        async with websockets.serve(self._handle_client, "127.0.0.1", 9999):
            await asyncio.sleep(5)   # give the client time to send all frames

    async def _handle_client(self, ws):
        async for frame in ws:
            data = frame if isinstance(frame, bytes) else frame.encode()
            # Identify frame by first byte / JSON key and write to disk.
            # (Extend this mapping when new message shapes are added.)
            name = self._classify(data)
            if name:
                (OUT / f"{name}.bin").write_bytes(data)
                print(f"  captured {name}.bin ({len(data)} bytes)")

    def _classify(self, data: bytes) -> str | None:
        if data[0:1] in (b'\\x00', b'\\x01') and len(data) >= 13:
            pt = data[0]
            return "text_input" if pt == 0 else "audio_input"
        if data[0:1] in (b'\\x00', b'\\x01') and len(data) >= 37:
            return "interaction_response_jpeg"   # refine by payload type byte
        try:
            msg = json.loads(data)
            t = msg.get("type", "")
            mapping = {
                "cancelInteraction": "cancel_interaction",
                "endInteraction":    "end_interaction",
                "sessionReady":      "session_ready",
                "errorResponse":     "error_response",
            }
            return mapping.get(t)
        except Exception:
            return None


async def main():
    proxy = CapturingProxy()
    proxy_task = asyncio.create_task(proxy.run())

    # Point the SDK at the local proxy and drive a scripted session.
    client = OjinClient(
        url="ws://127.0.0.1:9999",
        api_key="test-key",
    )
    await client.connect()
    await client.send_text("Hello, Ojin!", timestamp=FIXED_TS)
    await client.send_text(
        "\\u3053\\u3093\\u306b\\u3061\\u306f",
        params={"language": "ja"},
        timestamp=FIXED_TS,
    )
    await client.send_audio(b"\\x00\\x00\\x01\\x00\\xff\\x7f\\x00\\x80", timestamp=FIXED_TS)
    await client.cancel_interaction()
    await client.end_interaction()
    await client.disconnect()

    await proxy_task
    print("Done — update fixture metadata JSONs with the captured Python SDK version.")


asyncio.run(main())
```

> **Note:** The exact Python SDK API (`send_text`, `send_audio`, etc.) may
> differ from the above skeleton.  Consult the Python `ojin-client` source
> under `ojin/ojin_client.py` for the current method signatures.

### After capturing

1. Update each `.json` sidecar's `pythonSdkVersion` field to match the exact
   version used during capture.
2. Run `pnpm test:wire-compat` to verify the TypeScript SDK still round-trips
   all captured frames.
3. Commit **both** the `.bin` and `.json` files.

---

## Binary protocol quick reference

### `InteractionInput` (client → server)

```text
Offset  Size  Endian  Field
──────────────────────────────────────────────
0       1     —       payloadType  (0=text, 1=audio, 2=image, 3=video)
1       4     BE      timestamp_high (always 0; ms timestamp fits in low 32)
5       4     BE      timestamp_low  (Unix time in milliseconds)
9       4     BE      paramsSize     (byte length of JSON-encoded params)
13      N     —       params         (UTF-8 JSON string, N = paramsSize)
13+N    M     —       payload        (raw bytes, M = total - 13 - N)
```

### `InteractionResponse` (server → client)

```text
Offset  Size  Endian  Field
──────────────────────────────────────────────
0       1     —       isFinalResponse  (0=false, 1=true)
1       16    —       interactionId    (UUID bytes, big-endian)
17      4     BE      timestamp_high
21      4     BE      timestamp_low
25      4     BE      usage
29      4     BE      index
33      4     BE      numPayloads

Repeated numPayloads times:
  N      4     BE      dataSize
  N+4    1     —       payloadType
  N+5    M     —       payload data  (M = dataSize)
```

JSON messages (`cancelInteraction`, `endInteraction`, `sessionReady`,
`errorResponse`) are UTF-8-encoded JSON strings — no length prefix.
