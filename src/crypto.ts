import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedValue {
  ciphertext: string;
  nonce: string;
}

export const encryptString = (plaintext: string, key: Buffer): EncryptedValue => {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
    nonce: nonce.toString('base64'),
  };
};

export const decryptString = ({ ciphertext, nonce }: EncryptedValue, key: Buffer): string => {
  const raw = Buffer.from(ciphertext, 'base64');
  if (raw.length < TAG_BYTES) throw new Error('Encrypted value is malformed');
  const encrypted = raw.subarray(0, raw.length - TAG_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
};
