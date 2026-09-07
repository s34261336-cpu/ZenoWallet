import { logger } from "./logger";

export type Wallet = {
  user_id: number;
  earn_balance: number;
  zeno_balance: number;
  updated_at: string;
  daily_claimed_at: string | null;
  referred_by: number | null;
  referral_rewarded: boolean;
};

type SupabaseError = {
  message?: string;
  details?: string;
  hint?: string;
  code?: string;
};

export class SupabaseClient {
  private readonly baseUrl: string;
  private readonly key: string;

  constructor() {
    const url = process.env["SUPABASE_URL"];
    const key = process.env["SUPABASE_KEY"];

    if (!url || !key) {
      throw new Error("SUPABASE_URL and SUPABASE_KEY are required");
    }

    this.baseUrl = url.replace(/\/+$/, "");
    this.key = key;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      let details = response.statusText;
      try {
        const error = (await response.json()) as SupabaseError;
        details = error.message ?? error.details ?? details;
      } catch {
        // Keep the HTTP status when Supabase does not return JSON.
      }
      throw new Error(`Supabase request failed (${response.status}): ${details}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  async getWallet(userId: number): Promise<Wallet | null> {
    const rows = await this.request<Wallet[]>(
      `wallet?select=user_id,earn_balance,zeno_balance,updated_at,daily_claimed_at,referred_by,referral_rewarded&user_id=eq.${userId}&limit=1`,
    );
    return rows[0] ?? null;
  }

  async createWallet(userId: number): Promise<Wallet> {
    const rows = await this.request<Wallet[]>("wallet", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: userId,
        earn_balance: 0,
        zeno_balance: 0,
      }),
    });
    return rows[0] as Wallet;
  }

  async ensureWallet(userId: number): Promise<Wallet> {
    const existing = await this.getWallet(userId);
    if (existing) {
      return existing;
    }

    try {
      return await this.createWallet(userId);
    } catch (error) {
      // Another update may have created the wallet between the select and insert.
      const createdByAnotherRequest = await this.getWallet(userId);
      if (createdByAnotherRequest) {
        return createdByAnotherRequest;
      }
      throw error;
    }
  }

  async updateWallet(
    userId: number,
    values: Partial<
      Pick<
        Wallet,
        | "earn_balance"
        | "zeno_balance"
        | "daily_claimed_at"
        | "referred_by"
        | "referral_rewarded"
      >
    >,
  ): Promise<Wallet> {
    const rows = await this.request<Wallet[]>(
      `wallet?user_id=eq.${userId}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          ...values,
          updated_at: new Date().toISOString(),
        }),
      },
    );
    return rows[0] as Wallet;
  }

  async credit(userId: number, amount: number): Promise<Wallet> {
    const wallet = await this.ensureWallet(userId);
    return this.updateWallet(userId, {
      earn_balance: wallet.earn_balance + amount,
    });
  }

  async claimDaily(userId: number): Promise<
    | { claimed: true; wallet: Wallet }
    | { claimed: false; wallet: Wallet; nextAvailableAt: Date }
  > {
    const wallet = await this.ensureWallet(userId);
    const now = Date.now();
    const lastClaim = wallet.daily_claimed_at
      ? new Date(wallet.daily_claimed_at).getTime()
      : null;
    const cooldownMs = 24 * 60 * 60 * 1000;

    if (lastClaim !== null && now - lastClaim < cooldownMs) {
      return {
        claimed: false,
        wallet,
        nextAvailableAt: new Date(lastClaim + cooldownMs),
      };
    }

    const updated = await this.updateWallet(userId, {
      earn_balance: wallet.earn_balance + 10,
      daily_claimed_at: new Date(now).toISOString(),
    });
    return { claimed: true, wallet: updated };
  }

  async openCase(userId: number, reward: number): Promise<Wallet> {
    return this.credit(userId, reward);
  }

  async claimReferral(
    inviterId: number,
    friendId: number,
  ): Promise<{ rewarded: boolean; wallet: Wallet }> {
    const friend = await this.ensureWallet(friendId);
    if (
      inviterId === friendId ||
      friend.referred_by !== null ||
      friend.referral_rewarded
    ) {
      return { rewarded: false, wallet: await this.ensureWallet(inviterId) };
    }

    await this.updateWallet(friendId, {
      referred_by: inviterId,
      referral_rewarded: true,
    });
    return { rewarded: true, wallet: await this.credit(inviterId, 50) };
  }

  async withdraw(userId: number, amount: number): Promise<
    | { withdrawn: true; wallet: Wallet }
    | { withdrawn: false; wallet: Wallet }
  > {
    const wallet = await this.ensureWallet(userId);
    if (wallet.earn_balance < amount) {
      return { withdrawn: false, wallet };
    }

    const updated = await this.updateWallet(userId, {
      earn_balance: wallet.earn_balance - amount,
      zeno_balance: wallet.zeno_balance + amount,
    });
    return { withdrawn: true, wallet: updated };
  }
}

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (!process.env["SUPABASE_URL"] || !process.env["SUPABASE_KEY"]) {
    return null;
  }

  if (!client) {
    client = new SupabaseClient();
  }
  return client;
}

export function logSupabaseError(error: unknown, context: string): void {
  logger.error({ err: error }, context);
}