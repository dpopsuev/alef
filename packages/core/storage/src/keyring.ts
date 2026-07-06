import { Entry } from "@napi-rs/keyring";
import type { AuthStore } from "./interfaces.js";

const SERVICE_NAME = "alef";

/**
 *
 */
export class KeyringAuthStore implements AuthStore {
	private entry(provider: string): Entry {
		return new Entry(SERVICE_NAME, provider);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async get(provider: string): Promise<string | undefined> {
		return this.entry(provider).getPassword() ?? undefined;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async set(provider: string, key: string): Promise<void> {
		this.entry(provider).setPassword(key);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async remove(provider: string): Promise<void> {
		try {
			this.entry(provider).deletePassword();
		} catch {
			// already deleted or never existed
		}
	}

	async list(): Promise<Array<{ provider: string; type: string }>> {
		const { findCredentials } = await import("@napi-rs/keyring");
		const creds = findCredentials(SERVICE_NAME);
		return creds.map((c: { account: string }) => ({ provider: c.account, type: "api_key" }));
	}
}
