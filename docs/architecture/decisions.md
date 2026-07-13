# Architecture decisions

1. **Electron owns the overlay.** Electron 43 directly implements Windows content protection and exposes the required window controls; native overlay code would add complexity without improving the public capture API.
2. **A C# sidecar owns bounded system-audio capture and key-up detection.** This avoids Electron native-addon ABI rebuilds and keeps Windows-specific code isolated. The first supported source is WASAPI system loopback. Process-tree application loopback remains experimental.
3. **SQLite FTS5 precedes embeddings.** It is offline, inspectable, inexpensive, and effective for project terminology. Semantic retrieval is gated on measured top-five recall below 85%.
4. **Conversation state is local.** The app sends a five-turn summary and uses Responses with `store:false`; it does not create server-side conversation objects.
5. **Grounding is enforced at the boundary.** The model receives explicit chunk IDs, and returned evidence is filtered against the chunks actually sent. Missing project evidence produces a warning.
6. **Continuous listening is not shipped.** It requires separate accuracy, cost, consent, and stop-latency validation.
