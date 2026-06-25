/**
 * Tiny client for the ConclaveServer blob store — the data-exchange path. Upload a payload
 * once, get a content-addressed reference, put that reference in a bus message's artifacts,
 * and the other side downloads it by sha256. The bus carries the reference; the server
 * carries the bytes.
 */
export interface BlobRef {
  sha256: string;
  size: number;
  uri: string; // conclave://blobs/<sha256>
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Upload bytes to the server's blob store; returns the content-addressed reference. */
export async function uploadBlob(httpBase: string, data: Uint8Array | string, token?: string): Promise<BlobRef> {
  const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const res = await fetch(`${httpBase.replace(/\/$/, "")}/blobs`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", ...authHeaders(token) },
    body,
  });
  if (!res.ok) throw new Error(`blob upload failed: ${res.status}`);
  return (await res.json()) as BlobRef;
}

/** Download a blob by sha256 (or a conclave://blobs/<sha> uri) from the server. */
export async function downloadBlob(httpBase: string, shaOrUri: string, token?: string): Promise<Uint8Array> {
  const sha = shaOrUri.replace(/^conclave:\/\/blobs\//, "");
  const res = await fetch(`${httpBase.replace(/\/$/, "")}/blobs/${sha}`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`blob download failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Streaming relay — data exchange that the server does NOT store. Send bytes on a named
 * channel; the call blocks until a receiver connects to the same channel, then the bytes
 * pipe straight through the server (nothing written to disk). Pair with relayReceive.
 */
export async function relaySend(httpBase: string, channel: string, data: Uint8Array | string, token?: string): Promise<void> {
  const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const res = await fetch(`${httpBase.replace(/\/$/, "")}/relay/${channel}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", ...authHeaders(token) },
    body,
  });
  if (!res.ok) throw new Error(`relay send failed: ${res.status}`);
}

/** Receive bytes on a named channel — blocks until a sender connects. Nothing is stored server-side. */
export async function relayReceive(httpBase: string, channel: string, token?: string): Promise<Uint8Array> {
  const res = await fetch(`${httpBase.replace(/\/$/, "")}/relay/${channel}`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`relay receive failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
