import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, createPrivateKey, randomBytes } from "node:crypto";
import type { Envelope } from "./types.js";

/**
 * Agent identity & envelope signing (ed25519).
 *
 * The product-grade trust model: `agent://name` is just a handle; the PUBLIC KEY is the
 * real identity. A device generates its own keypair (private key never leaves it) and
 * registers only its public key with the server. Every envelope it publishes is signed,
 * so `from` cannot be spoofed and a stolen relay token alone buys nothing — you also need
 * the private key to act as an agent. Revocation = drop the key from the registry.
 *
 * Signatures cover a CANONICAL (recursively sorted-key) serialization of the envelope
 * minus `sig`, so independent encoders agree on the signed bytes.
 */
export interface Identity {
  name: string;
  id: string; // agent://name
  publicKey: string; // base64 SPKI DER
  privateKey: string; // base64 PKCS8 DER  (secret — stays on the device)
}

/** A device-held identity without the private key — what the server stores / peers see. */
export type PublicIdentity = Omit<Identity, "privateKey">;

export function agentUri(name: string): string {
  return name.startsWith("agent://") ? name : `agent://${name}`;
}

export function generateIdentity(name: string): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    name,
    id: agentUri(name),
    publicKey: (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64"),
    privateKey: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64"),
  };
}

/** Deterministic JSON: object keys sorted recursively, so signer and verifier hash the same bytes. */
export function canonicalJSON(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJSON).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(o[k])).join(",") + "}";
}

function canonicalBytes(env: Envelope): Buffer {
  const rest: Record<string, unknown> = { ...env };
  delete rest.sig; // the signature never signs itself
  return Buffer.from(canonicalJSON(rest), "utf8");
}

/** Return a copy of `env` with an ed25519 `sig` over its canonical bytes. */
export function signEnvelope(env: Envelope, privateKeyB64: string): Envelope {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  const sig = edSign(null, canonicalBytes(env), key).toString("base64");
  return { ...env, sig };
}

/** True iff `env.sig` is a valid signature by `publicKeyB64` over the envelope's canonical bytes. */
export function verifyEnvelope(env: Envelope, publicKeyB64: string): boolean {
  if (!env.sig) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return edVerify(null, canonicalBytes(env), key, Buffer.from(env.sig, "base64"));
  } catch {
    return false;
  }
}

/** A high-entropy, URL-safe one-time token (enrollment / admin secrets). */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
