import assert from "node:assert/strict"
import {
  createCipheriv,
  pbkdf2Sync,
  randomBytes,
  scryptSync,
} from "node:crypto"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { keccak256 } from "viem"
import { privateKeyToAccount } from "viem/accounts"

import {
  accountFromKeystore,
  decryptKeystore,
  readPasswordFile,
} from "./keystore"

/** Builds a Web3 Secret Storage v3 keystore independently of the code under test. */
function encrypt(
  privateKey: Buffer,
  password: string,
  kdf: "scrypt" | "pbkdf2" = "scrypt"
) {
  const salt = randomBytes(32)
  const iv = randomBytes(16)
  const derived =
    kdf === "scrypt"
      ? scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 })
      : pbkdf2Sync(password, salt, 1000, 32, "sha256")
  const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv)
  const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()])
  const mac = keccak256(
    Buffer.concat([derived.subarray(16, 32), ciphertext])
  ).slice(2)
  return {
    version: 3,
    crypto: {
      cipher: "aes-128-ctr",
      cipherparams: { iv: iv.toString("hex") },
      ciphertext: ciphertext.toString("hex"),
      kdf,
      kdfparams:
        kdf === "scrypt"
          ? { dklen: 32, n: 1024, p: 1, r: 8, salt: salt.toString("hex") }
          : {
              c: 1000,
              dklen: 32,
              prf: "hmac-sha256",
              salt: salt.toString("hex"),
            },
      mac,
    },
  }
}

// Random per run: no key material is stored in the repository.
const key = randomBytes(32)
const privateKey = `0x${key.toString("hex")}` as const
const address = privateKeyToAccount(privateKey).address
const PASSWORD = "correct horse battery staple 8f3a"

describe("keystore decryption", () => {
  it("decrypts a spec-built scrypt keystore", () => {
    assert.equal(
      decryptKeystore(JSON.stringify(encrypt(key, PASSWORD)), PASSWORD),
      privateKey
    )
  })

  it("decrypts a pbkdf2 keystore", () => {
    assert.equal(
      decryptKeystore(
        JSON.stringify(encrypt(key, PASSWORD, "pbkdf2")),
        PASSWORD
      ),
      privateKey
    )
  })

  it("accepts the legacy capitalised Crypto section", () => {
    const ks = encrypt(key, PASSWORD)
    assert.equal(
      decryptKeystore(
        JSON.stringify({ version: 3, Crypto: ks.crypto }),
        PASSWORD
      ),
      privateKey
    )
  })

  it("rejects a wrong password without revealing it or the key", () => {
    const json = JSON.stringify(encrypt(key, PASSWORD))
    for (const wrong of ["", "wrong", PASSWORD + " "]) {
      try {
        decryptKeystore(json, wrong)
        assert.fail("should have thrown")
      } catch (error) {
        const message = (error as Error).message
        assert.match(message, /wrong password or corrupted keystore/)
        assert.ok(
          !message.includes(PASSWORD) && !message.includes(privateKey.slice(2))
        )
      }
    }
  })

  it("rejects a tampered ciphertext or MAC", () => {
    const ks = encrypt(key, PASSWORD)
    const flip = (hex: string) => (hex[0] === "0" ? "1" : "0") + hex.slice(1)
    assert.throws(
      () =>
        decryptKeystore(
          JSON.stringify({
            ...ks,
            crypto: { ...ks.crypto, ciphertext: flip(ks.crypto.ciphertext) },
          }),
          PASSWORD
        ),
      /wrong password or corrupted/
    )
    assert.throws(
      () =>
        decryptKeystore(
          JSON.stringify({
            ...ks,
            crypto: { ...ks.crypto, mac: flip(ks.crypto.mac) },
          }),
          PASSWORD
        ),
      /wrong password or corrupted/
    )
  })

  it("rejects malformed or unsupported keystores", () => {
    const ks = encrypt(key, PASSWORD)
    const bad: [string, string][] = [
      ["not json", "{"],
      ["no crypto section", "{}"],
      [
        "other cipher",
        JSON.stringify({ crypto: { ...ks.crypto, cipher: "aes-256-gcm" } }),
      ],
      [
        "other kdf",
        JSON.stringify({ crypto: { ...ks.crypto, kdf: "argon2" } }),
      ],
      [
        "non-hex ciphertext",
        JSON.stringify({ crypto: { ...ks.crypto, ciphertext: "zz" } }),
      ],
      [
        "huge scrypt N (DoS)",
        JSON.stringify({
          crypto: {
            ...ks.crypto,
            kdfparams: { ...ks.crypto.kdfparams, n: 1 << 30 },
          },
        }),
      ],
      [
        "non power-of-two N",
        JSON.stringify({
          crypto: {
            ...ks.crypto,
            kdfparams: { ...ks.crypto.kdfparams, n: 1000 },
          },
        }),
      ],
      [
        "bad dklen",
        JSON.stringify({
          crypto: {
            ...ks.crypto,
            kdfparams: { ...ks.crypto.kdfparams, dklen: 8 },
          },
        }),
      ],
    ]
    for (const [label, json] of bad) {
      assert.throws(() => decryptKeystore(json, PASSWORD), /keystore/, label)
    }
  })
})

describe("accountFromKeystore", () => {
  const dir = mkdtempSync(join(tmpdir(), "duely-ks-"))
  writeFileSync(
    join(dir, "test-account"),
    JSON.stringify(encrypt(key, PASSWORD))
  )

  it("returns the account only when its address is the expected one (any casing)", () => {
    const account = accountFromKeystore({
      dir,
      name: "test-account",
      password: PASSWORD,
      expectedAddress: address,
    })
    assert.equal(account.address, address)
    assert.doesNotThrow(() =>
      accountFromKeystore({
        dir,
        name: "test-account",
        password: PASSWORD,
        expectedAddress: address.toLowerCase(),
      })
    )
  })

  it("refuses a keystore that holds a different address, before anything can be signed", () => {
    assert.throws(
      () =>
        accountFromKeystore({
          dir,
          name: "test-account",
          password: PASSWORD,
          expectedAddress: "0x1111111111111111111111111111111111111111",
        }),
      /holds 0x[0-9a-fA-F]{40}, but 0x1111111111111111111111111111111111111111 was expected/
    )
  })

  it("rejects keystore names that could escape the directory", () => {
    for (const name of ["../test-account", "a/b", "", "..", "x y"]) {
      assert.throws(
        () =>
          accountFromKeystore({
            dir,
            name,
            password: PASSWORD,
            expectedAddress: address,
          }),
        /unsupported characters/,
        name
      )
    }
  })

  it("never puts the password or key in an error", () => {
    try {
      accountFromKeystore({
        dir,
        name: "test-account",
        password: "nope-nope",
        expectedAddress: address,
      })
      assert.fail("should throw")
    } catch (error) {
      assert.ok(!(error as Error).message.includes("nope-nope"))
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 0 })
  })
})

describe("compatibility with a real Foundry keystore", () => {
  let hasCast = true
  try {
    execFileSync("cast", ["--version"], { stdio: "ignore" })
  } catch {
    hasCast = false
  }

  it(
    "decrypts a keystore created by `cast wallet import`",
    { skip: !hasCast && "cast not installed" },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "duely-cast-"))
      try {
        const throwaway = randomBytes(32)
        const throwawayKey = `0x${throwaway.toString("hex")}` as const
        execFileSync(
          "cast",
          [
            "wallet",
            "import",
            "foundry-made",
            "--keystore-dir",
            dir,
            "--private-key",
            throwawayKey,
            "--unsafe-password",
            "throwaway-test-pw",
          ],
          { stdio: "ignore" }
        )
        const account = accountFromKeystore({
          dir,
          name: "foundry-made",
          password: "throwaway-test-pw",
          expectedAddress: privateKeyToAccount(throwawayKey).address,
        })
        assert.equal(account.address, privateKeyToAccount(throwawayKey).address)
        assert.throws(
          () =>
            accountFromKeystore({
              dir,
              name: "foundry-made",
              password: "wrong",
              expectedAddress: account.address,
            }),
          /wrong password/
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})

describe("password files", () => {
  it("reads a mode-600 file and strips only the trailing newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "duely-pw-"))
    try {
      const file = join(dir, "pw")
      writeFileSync(file, "  spaced pass \n")
      chmodSync(file, 0o600)
      assert.equal(readPasswordFile(file), "  spaced pass ")
      writeFileSync(file, "crlf\r\n")
      assert.equal(readPasswordFile(file), "crlf")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses a file other users can read", () => {
    const dir = mkdtempSync(join(tmpdir(), "duely-pw-"))
    try {
      const file = join(dir, "pw")
      writeFileSync(file, "secret")
      for (const mode of [0o644, 0o640, 0o604, 0o666]) {
        chmodSync(file, mode)
        assert.throws(
          () => readPasswordFile(file),
          /chmod 600/,
          mode.toString(8)
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
