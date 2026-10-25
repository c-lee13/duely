import {
  createDecipheriv,
  pbkdf2Sync,
  scryptSync,
  timingSafeEqual,
} from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { keccak256, type Hex } from "viem"
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts"

/**
 * Local signing from Foundry keystores (Web3 Secret Storage v3: scrypt/pbkdf2 + aes-128-ctr +
 * keccak MAC), decrypted in-process. The private key and password live only in memory: they are
 * never printed, logged, passed on a command line, or written to disk.
 */

interface KdfParams {
  n?: number
  r?: number
  p?: number
  c?: number
  prf?: string
  dklen: number
  salt: string
}

interface CryptoSection {
  cipher: string
  ciphertext: string
  cipherparams: { iv: string }
  kdf: string
  kdfparams: KdfParams
  mac: string
}

const MAX_SCRYPT_N = 1 << 20
const MAX_PBKDF2_ROUNDS = 10_000_000

function hex(value: unknown, what: string): Buffer {
  if (typeof value !== "string" || !/^([0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`keystore: ${what} is not hex`)
  }
  return Buffer.from(value, "hex")
}

/** Decrypts a keystore JSON string and returns the private key. Throws on a wrong password. */
export function decryptKeystore(json: string, password: string): Hex {
  let parsed: { crypto?: CryptoSection; Crypto?: CryptoSection }
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error("keystore: not valid JSON")
  }
  const section = parsed.crypto ?? parsed.Crypto
  if (!section || section.cipher !== "aes-128-ctr") {
    throw new Error("keystore: unsupported format (expected aes-128-ctr)")
  }
  const ciphertext = hex(section.ciphertext, "ciphertext")
  const iv = hex(section.cipherparams?.iv, "iv")
  const salt = hex(section.kdfparams?.salt, "salt")
  const dklen = section.kdfparams?.dklen
  if (!Number.isInteger(dklen) || dklen < 32 || dklen > 128) {
    throw new Error("keystore: unsupported dklen")
  }

  let derived: Buffer
  if (section.kdf === "scrypt") {
    const { n, r, p } = section.kdfparams
    if (!n || !r || !p || n > MAX_SCRYPT_N || (n & (n - 1)) !== 0) {
      throw new Error("keystore: unsupported scrypt parameters")
    }
    derived = scryptSync(password, salt, dklen, {
      N: n,
      r,
      p,
      maxmem: 1024 * 1024 * 1024,
    })
  } else if (section.kdf === "pbkdf2") {
    const { c, prf } = section.kdfparams
    if (!c || c > MAX_PBKDF2_ROUNDS || prf !== "hmac-sha256") {
      throw new Error("keystore: unsupported pbkdf2 parameters")
    }
    derived = pbkdf2Sync(password, salt, c, dklen, "sha256")
  } else {
    throw new Error(`keystore: unsupported kdf ${String(section.kdf)}`)
  }

  const expectedMac = hex(section.mac, "mac")
  const actualMac = Buffer.from(
    keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2),
    "hex"
  )
  if (
    expectedMac.length !== actualMac.length ||
    !timingSafeEqual(expectedMac, actualMac)
  ) {
    derived.fill(0)
    throw new Error("keystore: wrong password or corrupted keystore")
  }

  const decipher = createDecipheriv("aes-128-ctr", derived.subarray(0, 16), iv)
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  derived.fill(0)
  if (key.length !== 32) {
    key.fill(0)
    throw new Error("keystore: unexpected key length")
  }
  const privateKey = `0x${key.toString("hex")}` as Hex
  key.fill(0)
  return privateKey
}

/**
 * Loads `<dir>/<name>`, decrypts it, and returns a signing account, but only if its address
 * equals `expectedAddress`. A mismatch throws before anything can be signed.
 */
export function accountFromKeystore(args: {
  dir: string
  name: string
  password: string
  expectedAddress: string
}): PrivateKeyAccount {
  if (
    !/^[A-Za-z0-9._-]+$/.test(args.name) ||
    args.name === "." ||
    args.name === ".."
  ) {
    throw new Error(
      `keystore name "${args.name}" contains unsupported characters`
    )
  }
  const json = readFileSync(join(args.dir, args.name), "utf8")
  const account = privateKeyToAccount(decryptKeystore(json, args.password))
  if (account.address.toLowerCase() !== args.expectedAddress.toLowerCase()) {
    throw new Error(
      `keystore "${args.name}" holds ${account.address}, but ${args.expectedAddress} was expected`
    )
  }
  return account
}

/** Reads a password from a file the caller keeps at mode 600 (group/other access is refused). */
export function readPasswordFile(path: string): string {
  const mode = statSync(path).mode
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `password file ${path} is readable by other users; run: chmod 600 ${path}`
    )
  }
  return readFileSync(path, "utf8").replace(/\r?\n$/, "")
}

/** Prompts for a secret on the terminal without echoing it. Requires a TTY. */
export function promptHidden(prompt: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    return Promise.reject(
      new Error(
        "no terminal for the password prompt; set the matching *_PASSWORD_FILE"
      )
    )
  }
  process.stderr.write(prompt)
  return new Promise((resolve, reject) => {
    let value = ""
    const finish = (error?: Error) => {
      stdin.removeListener("data", onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write("\n")
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish()
        if (ch === "\u0003") return finish(new Error("cancelled"))
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on("data", onData)
  })
}
