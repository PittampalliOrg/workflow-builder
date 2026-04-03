import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

export type EncryptedObject = {
	iv: string;
	data: string;
};

function isHex(s: string): boolean {
	return /^[0-9a-fA-F]+$/.test(s);
}

function getEncryptionKey(): Buffer {
	const secret = env.AP_ENCRYPTION_KEY;

	if (!secret) {
		throw new Error(
			'AP_ENCRYPTION_KEY environment variable is required for encrypting connection credentials. ' +
				'Generate one with: openssl rand -hex 32'
		);
	}

	if (secret.length === 64 && isHex(secret)) {
		return Buffer.from(secret, 'hex');
	}

	if (secret.length === 32) {
		return Buffer.from(secret, 'binary');
	}

	throw new Error(
		`AP_ENCRYPTION_KEY must be either a 64-char hex string or a 32-char string. Got ${secret.length} characters.`
	);
}

export function encryptString(plaintext: string): EncryptedObject {
	const key = getEncryptionKey();
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM, key, iv);

	let encrypted = cipher.update(plaintext, 'utf8', 'hex');
	encrypted += cipher.final('hex');

	return {
		iv: iv.toString('hex'),
		data: encrypted
	};
}

export function decryptString(encryptedObject: EncryptedObject): string {
	const key = getEncryptionKey();
	const iv = Buffer.from(encryptedObject.iv, 'hex');
	const decipher = createDecipheriv(ALGORITHM, key, iv);

	let decrypted = decipher.update(encryptedObject.data, 'hex', 'utf8');
	decrypted += decipher.final('utf8');

	return decrypted;
}

export function encryptObject(obj: Record<string, unknown>): EncryptedObject {
	return encryptString(JSON.stringify(obj));
}

export function decryptObject<T extends Record<string, unknown> = Record<string, unknown>>(
	encryptedObject: EncryptedObject
): T {
	const decrypted = decryptString(encryptedObject);
	return JSON.parse(decrypted) as T;
}
