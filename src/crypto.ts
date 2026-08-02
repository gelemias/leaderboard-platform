const textEncoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function createOpaqueToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return bytesToBase64Url(bytes);
}

export function createRunSeed(): number {
	const values = new Uint32Array(1);
	crypto.getRandomValues(values);
	return values[0];
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
	return bytesToHex(new Uint8Array(digest));
}
