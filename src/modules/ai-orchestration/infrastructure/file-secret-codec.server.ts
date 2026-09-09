/**
 * File-backed AES-256-GCM secret codec. The webapp has no Electron
 * `safeStorage` boundary, so model API keys are encrypted with a host-scoped
 * 256-bit key stored at `<dataRoot>/<APP_DATA_DIR>/secure/secrets.key` (mode
 * 0600, directory 0700). The key is generated lazily on first use and cached
 * for the process. A key left at the pre-fix `<dataRoot>/secure/secrets.key`
 * is still read so existing secrets keep decrypting.
 *
 * This gives at-rest protection against casual SQLite inspection: `secure_secrets`
 * rows contain only authenticated ciphertext, never the plaintext key. It is not
 * a replacement for an OS credential store — anyone who can read the data root
 * can read the key file too — which is why the codec's `encryptionKind` is
 * reported as "keychain" only for schema compatibility (the `secure_secrets`
 * CHECK allows exactly `dpapi | keychain | safe-storage`); the mechanism is a
 * data-root key file, and that distinction is documented here rather than
 * mislabelled as an OS wallet.
 *
 * Ciphertext layout: `iv (12B) | authTag (16B) | AES-GCM(plaintext)`.
 */
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { APP_DATA_DIR } from "../../../lib/app-config.ts";
import type {
  EncryptedModelSecret,
  ModelSecretCodec,
} from "./sqlite-model-profile-repository.server.ts";

/**
 * Key file location, kept inside the application data directory alongside the
 * SQLite database instead of directly under the data root. A bare `secure/`
 * folder in `$HOME` is easy to sync to cloud storage or delete by accident,
 * and both outcomes are worse here than anywhere else: the file is the only
 * thing standing between an on-disk ciphertext and every stored provider key.
 */
const KEY_PATH = join(APP_DATA_DIR, "secure", "secrets.key");
/** Pre-fix location (`<dataRoot>/secure/secrets.key`); read-only fallback. */
const LEGACY_KEY_PATH = join("secure", "secrets.key");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
/** Also the `error.code` carried on failures so the server-fn layer maps it. */
const ERROR_CODE = "errors.modelProfile.safeStorageUnavailable";

function codecFailure(cause?: unknown): Error {
  const error = new Error(ERROR_CODE);
  Object.defineProperty(error, "code", {
    value: ERROR_CODE,
    enumerable: true,
    writable: false,
  });
  if (cause instanceof Error) {
    // Preserve the underlying I/O or cipher error for diagnostics.
    Object.defineProperty(error, "cause", {
      value: cause,
      enumerable: false,
    });
  }
  return error;
}

export interface FileSecretCodecOptions {
  readonly dataRoot: string;
}

export function createFileSecretCodec(
  options: FileSecretCodecOptions,
): ModelSecretCodec {
  const keyPath = join(options.dataRoot, KEY_PATH);
  const legacyKeyPath = join(options.dataRoot, LEGACY_KEY_PATH);
  let cachedKey: Buffer | undefined;

  async function readKeyFile(path: string = keyPath): Promise<Buffer> {
    const key = await readFile(path);
    return key;
  }

  function isMissing(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  }

  async function loadKey(): Promise<Buffer> {
    if (cachedKey) return cachedKey;
    let key: Buffer;
    // The path the key was actually taken from; a legacy key keeps living where
    // it is, because moving it would break a concurrently running older build.
    let resolvedPath = keyPath;
    try {
      key = await readKeyFile();
    } catch (readError) {
      if (!isMissing(readError)) {
        throw codecFailure(readError);
      }
      try {
        // Installations created before the key moved under the app data
        // directory keep their existing key so stored secrets stay readable.
        key = await readKeyFile(legacyKeyPath);
        resolvedPath = legacyKeyPath;
      } catch (legacyError) {
        if (!isMissing(legacyError)) {
          throw codecFailure(legacyError);
        }
        // First use: mint a fresh key. `wx` makes creation exclusive so a second
        // process racing us falls back to reading the winner's key.
        const fresh = randomBytes(32);
        try {
          await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
          await writeFile(keyPath, fresh, { mode: 0o600, flag: "wx" });
          key = fresh;
        } catch (writeError) {
          if (
            writeError instanceof Error &&
            (writeError as NodeJS.ErrnoException).code === "EEXIST"
          ) {
            key = await readKeyFile().catch((again) => {
              throw codecFailure(again);
            });
          } else {
            throw codecFailure(writeError);
          }
        }
      }
    }
    // Best-effort hardening against umask loosening the file mode.
    await chmod(resolvedPath, 0o600).catch(() => undefined);
    cachedKey = key;
    return key;
  }

  return {
    async encrypt(plaintext: string): Promise<EncryptedModelSecret> {
      const key = await loadKey();
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return {
        ciphertext: new Uint8Array(Buffer.concat([iv, tag, encrypted])),
        encryptionKind: "keychain",
      };
    },

    async decrypt(secret: EncryptedModelSecret): Promise<string> {
      const blob = Buffer.from(secret.ciphertext);
      if (blob.byteLength < IV_LENGTH + TAG_LENGTH) throw codecFailure();
      const iv = blob.subarray(0, IV_LENGTH);
      const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
      const data = blob.subarray(IV_LENGTH + TAG_LENGTH);
      const key = await loadKey();
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(data),
          decipher.final(),
        ]).toString("utf8");
      } catch (cause) {
        // Auth-tag mismatch (wrong key / tampered blob) surfaces as a codec
        // failure, not a raw cipher error.
        throw codecFailure(cause);
      }
    },
  };
}
